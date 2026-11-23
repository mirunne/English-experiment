/**
 * English Experiment — Google Drive upload endpoint
 *
 * Run setupDriveFolder() once as the researcher, then deploy this project
 * as a web app that executes as the deploying user and permits anonymous access.
 *
 * Public surface:
 *   POST  doPost: participant registration, beginUpload / uploadChunk
 *   GET   doGet: read-only upload status (JSONP)
 *
 * The script never exposes Drive listing, reading, downloading, or deletion.
 */

const EE_CONFIG = {
  ROOT_FOLDER_NAME: "English Experiment Data",
  MAX_FILE_SIZE: 60 * 1024 * 1024,
  MAX_PARTICIPANT_FOLDERS: 1000,
  CHUNK_SIZE: 4 * 1024 * 1024,
  CACHE_SECONDS: 21600,
  ALLOWED_FILES: {
    "participant_device_info.json": "application/json",
    "part_I_word_reading.wav": "audio/wav",
    "part_I_metadata.json": "application/json",
    "part_II_passage_reading.wav": "audio/wav",
    "part_II_metadata.json": "application/json",
    "part_II_section_1_reading.wav": "audio/wav",
    "part_II_section_1_metadata.json": "application/json",
    "part_II_section_2_reading.wav": "audio/wav",
    "part_II_section_2_metadata.json": "application/json",
    "part_III_speech_ratings.json": "application/json",
    "part_IV_questionnaire.json": "application/json"
  }
};


/**
 * Run manually once from the Apps Script editor.
 * Creates the private destination folder and a random participant upload code.
 * Copy the upload code from the execution log and share it privately with participants.
 */
function setupDriveFolder() {
  const properties = PropertiesService.getScriptProperties();
  let folder = null;
  const existingId = properties.getProperty("EE_ROOT_FOLDER_ID");

  if (existingId) {
    try {
      folder = DriveApp.getFolderById(existingId);
    } catch (error) {
      properties.deleteProperty("EE_ROOT_FOLDER_ID");
    }
  }

  if (!folder) {
    folder = DriveApp.createFolder(EE_CONFIG.ROOT_FOLDER_NAME);
    properties.setProperty("EE_ROOT_FOLDER_ID", folder.getId());
  }

  let uploadCode = properties.getProperty("EE_UPLOAD_CODE");
  if (!uploadCode) {
    uploadCode = Utilities.getUuid().replace(/-/g, "").slice(0, 12).toUpperCase();
    properties.setProperty("EE_UPLOAD_CODE", uploadCode);
  }

  Logger.log("Drive destination: " + folder.getUrl());
  Logger.log("Participant upload code: " + uploadCode);
  return {
    folderUrl: folder.getUrl(),
    uploadCode: uploadCode
  };
}


/** Use this if you need to retrieve the code later from the execution log. */
function showUploadAccessCode() {
  const code = PropertiesService.getScriptProperties().getProperty("EE_UPLOAD_CODE");
  if (!code) throw new Error("Run setupDriveFolder() first.");
  Logger.log("Participant upload code: " + code);
  return code;
}


/**
 * Receives small JSON text/plain POST requests.
 * The browser uses no-cors mode and polls doGet() for an acknowledgment,
 * avoiding CORS preflight and cross-origin response restrictions.
 */
function doPost(event) {
  let request;

  try {
    const raw = event && event.postData && event.postData.contents;
    if (!raw || raw.length > 6000000) {
      throw new Error("Request body is missing or too large.");
    }

    request = JSON.parse(raw);

    if (!request || typeof request !== "object") {
      throw new Error("Invalid request.");
    }

    const requestId = String(request.requestId || "");
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(requestId)) {
      throw new Error("Invalid request identifier.");
    }

    const cache = CacheService.getScriptCache();
    const statusKey = "ee_req_" + requestId;

    // A repeated request ID is never processed twice.
    if (cache.get(statusKey)) {
      return ContentService.createTextOutput("accepted");
    }

    cache.put(statusKey, JSON.stringify({ state: "working" }), 300);

    try {
      const processingStartedAt = Date.now();
      requireUploadCode_(request.accessCode);

      let result;

      if (request.action === "verifyAccessCode") {
        const participantId = String(request.participantId || "").toLowerCase();
        const registration = registerParticipant_(participantId);
        result = {
          verified: true,
          participantCode: registration.participantCode
        };
      } else if (request.action === "beginUpload") {
        result = beginUpload_(request);
      } else if (request.action === "uploadChunk") {
        result = uploadChunk_(request);
      } else if (request.action === "getUploadStatus") {
        result = getUploadStatus_(request);
      } else {
        throw new Error("Unsupported upload action.");
      }

      if (result && typeof result === "object") {
        result._serverProcessingMs = Date.now() - processingStartedAt;
      }

      cache.put(
        statusKey,
        JSON.stringify({ state: "complete", result: result }),
        EE_CONFIG.CACHE_SECONDS
      );

    } catch (processingError) {

      cache.put(
        statusKey,
        JSON.stringify({
          state: "error",
          message: safeErrorMessage_(processingError)
        }),
        EE_CONFIG.CACHE_SECONDS
      );

    }

    return ContentService.createTextOutput("accepted");

  } catch (error) {
    // Detailed errors are not returned from this opaque POST response.
    return ContentService.createTextOutput("rejected");
  }
}


/**
 * Read-only JSONP status endpoint. It returns status only, not participant data.
 */
function doGet(event) {
  const parameters = event && event.parameter ? event.parameter : {};
  const callback = String(parameters.callback || "");
  const requestId = String(parameters.requestId || "");
  const action = String(parameters.action || "");

  let result;

  if (action === "ping") {

    result = { state: "ready" };

  } else if (
    action === "status" &&
    /^[A-Za-z0-9_-]{20,80}$/.test(requestId)
  ) {

    const cached = CacheService.getScriptCache().get("ee_req_" + requestId);

    if (!cached) {
      result = { state: "pending" };
    } else {
      try {
        result = JSON.parse(cached);
        if (result.state === "working") {
          result = { state: "pending" };
        }
      } catch (error) {
        result = { state: "pending" };
      }
    }

  } else {

    result = { state: "error", message: "Invalid status request." };

  }

  const json = JSON.stringify(result).replace(/</g, "\\u003c");

  if (callback !== "__eeReceiveUploadStatus") {
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(callback + "(" + json + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}


function requireUploadCode_(provided) {
  const expected = PropertiesService
    .getScriptProperties()
    .getProperty("EE_UPLOAD_CODE");

  if (!expected) {
    throw new Error("Drive setup has not been completed.");
  }

  const supplied = String(provided || "");
  if (supplied.length !== expected.length) {
    throw new Error("The participant upload code is incorrect.");
  }

  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }

  if (difference !== 0) {
    throw new Error("The participant upload code is incorrect.");
  }
}


function beginUpload_(request) {
  const participantId = String(request.participantId || "").toLowerCase();
  const participantCode = String(request.participantCode || "").toUpperCase();
  const fileName = String(request.fileName || "");
  const mimeType = String(request.mimeType || "");
  const fileSize = Number(request.fileSize);

  if (!/^[a-f0-9]{32}$/.test(participantId)) {
    throw new Error("Invalid participant ID.");
  }

  if (!/^[A-Z]{2}[0-9]{2}$/.test(participantCode)) {
    throw new Error("Invalid participant code.");
  }

  if (!Object.prototype.hasOwnProperty.call(EE_CONFIG.ALLOWED_FILES, fileName)) {
    throw new Error("This file name is not allowed.");
  }

  if (EE_CONFIG.ALLOWED_FILES[fileName] !== mimeType) {
    throw new Error("The file type does not match the expected file type.");
  }

  if (
    !Number.isSafeInteger(fileSize) ||
    fileSize < 1 ||
    fileSize > EE_CONFIG.MAX_FILE_SIZE
  ) {
    throw new Error("The file size is outside the permitted limit.");
  }

  const participantFolder = getParticipantFolder_(participantId, participantCode);
  const existingFile = findFileByName_(participantFolder, fileName);

  // Prevent duplicate files when a previous upload completed but its acknowledgment was lost.
  if (existingFile) {
    return {
      alreadyUploaded: true,
      fileName: fileName,
      nextOffset: fileSize
    };
  }

  if (countFiles_(participantFolder) >= Object.keys(EE_CONFIG.ALLOWED_FILES).length) {
    throw new Error("The permitted number of files has already been reached.");
  }

  const metadata = {
    name: fileName,
    mimeType: mimeType,
    parents: [participantFolder.getId()]
  };

  const response = UrlFetchApp.fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    {
      method: "post",
      contentType: "application/json; charset=UTF-8",
      headers: {
        Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(fileSize)
      },
      payload: JSON.stringify(metadata),
      muteHttpExceptions: true,
      followRedirects: false
    }
  );

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Google Drive could not start the upload (HTTP " + code + ").");
  }

  const location = getHeader_(response.getAllHeaders(), "Location");
  if (!location) {
    throw new Error("Google Drive did not return an upload session.");
  }

  const uploadId = Utilities.getUuid().replace(/-/g, "");
  const session = {
    sessionUrl: String(location),
    participantId: participantId,
    fileName: fileName,
    mimeType: mimeType,
    fileSize: fileSize,
    folderId: participantFolder.getId()
  };

  CacheService.getScriptCache().put(
    "ee_upload_" + uploadId,
    JSON.stringify(session),
    EE_CONFIG.CACHE_SECONDS
  );

  const uploadResult = {
    alreadyUploaded: false,
    uploadId: uploadId,
    fileName: fileName,
    chunkSize: EE_CONFIG.CHUNK_SIZE,
    nextOffset: 0
  };

  // Researcher-only trial: the temporary resumable session URL lets the
  // browser upload the binary Blob directly to Drive, bypassing Base64
  // transport through Apps Script. Never include it in normal responses.
  if (request.directUploadTest === true) {
    uploadResult.uploadUrl = String(location);
  }

  return uploadResult;
}


function uploadChunk_(request) {
  const uploadId = String(request.uploadId || "").toLowerCase();
  const offset = Number(request.offset);
  const base64Data = String(request.data || "");

  if (!/^[a-f0-9]{32}$/.test(uploadId)) {
    throw new Error("Invalid upload session.");
  }

  const stored = CacheService.getScriptCache().get("ee_upload_" + uploadId);
  if (!stored) {
    throw new Error("The upload session has expired. Please restart this upload.");
  }

  const session = JSON.parse(stored);

  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= session.fileSize
  ) {
    throw new Error("Invalid upload position.");
  }

  if (!base64Data || base64Data.length > 5800000) {
    throw new Error("The upload chunk is missing or too large.");
  }

  const decodeStartedAt = Date.now();
  const bytes = Utilities.base64Decode(base64Data);
  const decodeMs = Date.now() - decodeStartedAt;
  const expectedLength = Math.min(
    EE_CONFIG.CHUNK_SIZE,
    session.fileSize - offset
  );

  if (bytes.length !== expectedLength) {
    throw new Error("The upload chunk has an unexpected size.");
  }

  // A newly created upload session starts at offset 0, so send its first
  // chunk directly instead of making an extra status request to Drive.
  // For resumed chunks, query Drive first to avoid retransmitting bytes that
  // may already have been accepted if a previous response was interrupted.
  if (offset > 0) {
    const remote = queryDriveUpload_(session);

    if (remote.expired) {
      throw new Error("The Google Drive upload session expired. Please restart this upload.");
    }

    if (remote.completed) {
      return {
        completed: true,
        fileName: session.fileName,
        nextOffset: session.fileSize
      };
    }

    if (remote.nextOffset !== offset) {
      return {
        completed: false,
        nextOffset: remote.nextOffset,
        retryFromOffset: true
      };
    }
  }

  const end = offset + bytes.length - 1;
  const drivePutStartedAt = Date.now();
  const response = UrlFetchApp.fetch(
    session.sessionUrl,
    {
      method: "put",
      contentType: session.mimeType,
      headers: {
        Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        "Content-Range": "bytes " + offset + "-" + end + "/" + session.fileSize
      },
      payload: bytes,
      muteHttpExceptions: true,
      followRedirects: false
    }
  );

  const drivePutMs = Date.now() - drivePutStartedAt;
  const code = response.getResponseCode();
  const timing = {
    decodeMs: decodeMs,
    drivePutMs: drivePutMs,
    driveHttpStatus: code
  };

  if (code === 308) {
    return {
      completed: false,
      nextOffset: getNextOffset_(response.getAllHeaders()),
      _serverStages: timing
    };
  }

  if (code === 200 || code === 201) {
    return {
      completed: true,
      fileName: session.fileName,
      nextOffset: session.fileSize,
      _serverStages: timing
    };
  }

  if (code === 404 || code === 410) {
    throw new Error("The Google Drive upload session expired. Please restart this upload.");
  }

  throw new Error("Google Drive did not accept the upload chunk (HTTP " + code + ").");
}


function getUploadStatus_(request) {
  const uploadId = String(request.uploadId || "").toLowerCase();
  const participantId = String(request.participantId || "").toLowerCase();
  const participantCode = String(request.participantCode || "").toUpperCase();

  if (!/^[a-f0-9]{32}$/.test(uploadId)) {
    throw new Error("Invalid upload session.");
  }

  const stored = CacheService.getScriptCache().get("ee_upload_" + uploadId);
  if (!stored) {
    throw new Error("The upload session has expired. Please restart this upload.");
  }

  const session = JSON.parse(stored);
  const participantFolder = getParticipantFolder_(participantId, participantCode);

  if (
    session.participantId !== participantId ||
    session.folderId !== participantFolder.getId()
  ) {
    throw new Error("The upload session does not belong to this participant.");
  }

  const remote = queryDriveUpload_(session);

  if (remote.expired) {
    throw new Error("The Google Drive upload session expired. Please restart this upload.");
  }

  return {
    completed: remote.completed === true,
    fileName: session.fileName,
    fileSize: session.fileSize,
    nextOffset: remote.completed ? session.fileSize : remote.nextOffset
  };
}

function queryDriveUpload_(session) {
  const response = UrlFetchApp.fetch(
    session.sessionUrl,
    {
      method: "put",
      contentType: "application/octet-stream",
      headers: {
        Authorization: "Bearer " + ScriptApp.getOAuthToken(),
        "Content-Range": "bytes */" + session.fileSize
      },
      payload: "",
      muteHttpExceptions: true,
      followRedirects: false
    }
  );

  const code = response.getResponseCode();

  if (code === 308) {
    return {
      completed: false,
      nextOffset: getNextOffset_(response.getAllHeaders())
    };
  }

  if (code === 200 || code === 201) {
    return {
      completed: true,
      nextOffset: session.fileSize
    };
  }

  if (code === 404 || code === 410) {
    return {
      completed: false,
      expired: true,
      nextOffset: 0
    };
  }

  throw new Error("Google Drive upload status could not be checked (HTTP " + code + ").");
}


function getNextOffset_(headers) {
  const range = getHeader_(headers, "Range");
  if (!range) return 0;

  const match = String(range).match(/(\d+)-(\d+)/);
  return match ? Number(match[2]) + 1 : 0;
}


function getDriveRootFolder_() {
  const rootId = PropertiesService.getScriptProperties()
    .getProperty("EE_ROOT_FOLDER_ID");

  if (!rootId) {
    throw new Error("The Drive destination has not been configured. The researcher must run setupDriveFolder().");
  }

  return DriveApp.getFolderById(rootId);
}


/**
 * Assigns a permanent, unique two-letter/two-digit research code.
 * The script lock prevents simultaneous participants from receiving the same code.
 * The internal UUID is stored in the folder description, not its visible name.
 */
function registerParticipant_(participantId) {
  const id = String(participantId || "").toLowerCase();

  if (!/^[a-f0-9]{32}$/.test(id)) {
    throw new Error("Invalid participant ID.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const root = getDriveRootFolder_();
    const internalMarker = "EE_INTERNAL_PARTICIPANT_ID:" + id;
    const folders = root.getFolders();

    // Return the existing code if this browser session has already registered.
    while (folders.hasNext()) {
      const folder = folders.next();
      if (String(folder.getDescription() || "") === internalMarker) {
        const match = folder.getName().match(/^Participant_([A-Z]{2}[0-9]{2})$/);
        if (!match) {
          throw new Error("The participant's Drive folder has an invalid name.");
        }
        return { participantCode: match[1] };
      }
    }

    // Preserve data from an earlier UUID-named test folder by renaming it in place.
    const legacyFolders = root.getFoldersByName("Participant_" + id);
    if (legacyFolders.hasNext()) {
      const legacyFolder = legacyFolders.next();
      const legacyCode = generateUniqueParticipantCode_(root);
      legacyFolder.setName("Participant_" + legacyCode);
      legacyFolder.setDescription(internalMarker);
      return { participantCode: legacyCode };
    }

    if (countFolders_(root) >= EE_CONFIG.MAX_PARTICIPANT_FOLDERS) {
      throw new Error("The experiment's participant folder limit has been reached.");
    }

    const participantCode = generateUniqueParticipantCode_(root);
    const participantFolder = root.createFolder("Participant_" + participantCode);
    participantFolder.setDescription(internalMarker);

    return { participantCode: participantCode };

  } finally {
    lock.releaseLock();
  }
}


function generateUniqueParticipantCode_(root) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  // Every candidate is checked against Drive while the script lock is held.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const first = letters.charAt(Math.floor(Math.random() * letters.length));
    const second = letters.charAt(Math.floor(Math.random() * letters.length));
    const digits = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    const candidate = first + second + digits;

    if (!root.getFoldersByName("Participant_" + candidate).hasNext()) {
      return candidate;
    }
  }

  throw new Error("A unique participant code could not be allocated. Please try again.");
}


function getParticipantFolder_(participantId, participantCode) {
  const id = String(participantId || "").toLowerCase();
  const code = String(participantCode || "").toUpperCase();

  if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Z]{2}[0-9]{2}$/.test(code)) {
    throw new Error("Invalid participant identifiers.");
  }

  const root = getDriveRootFolder_();
  const folderName = "Participant_" + code;
  const internalMarker = "EE_INTERNAL_PARTICIPANT_ID:" + id;
  const matches = root.getFoldersByName(folderName);

  while (matches.hasNext()) {
    const folder = matches.next();
    if (String(folder.getDescription() || "") === internalMarker) {
      return folder;
    }
  }

  throw new Error("The participant folder could not be verified. Please reload the experiment and try again.");
}


function findFileByName_(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  return files.hasNext() ? files.next() : null;
}


function countFiles_(folder) {
  const files = folder.getFiles();
  let count = 0;

  while (files.hasNext()) {
    files.next();
    count++;
  }

  return count;
}


function countFolders_(folder) {
  const folders = folder.getFolders();
  let count = 0;

  while (folders.hasNext()) {
    folders.next();
    count++;
  }

  return count;
}


function getHeader_(headers, wantedName) {
  const wanted = wantedName.toLowerCase();

  for (const key in headers) {
    if (key.toLowerCase() === wanted) {
      return headers[key];
    }
  }

  return null;
}


function safeErrorMessage_(error) {
  const message = error && error.message
    ? String(error.message)
    : "The upload failed.";

  return message
    .replace(/https?:\/\/[^\s]+/g, "[service URL]")
    .slice(0, 240);
}
