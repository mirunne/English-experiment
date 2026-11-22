# Google Drive upload backend

This Apps Script project is the private storage endpoint for the English Experiment hosted on GitHub Pages.

## What it does

- Creates one private Drive folder named **English Experiment Data**.
- Creates a subfolder per anonymous participant ID.
- Accepts only the expected WAV and JSON filenames.
- Uploads files to Drive using resumable Drive API sessions in 1 MiB chunks.
- Supports retrying chunks after a network interruption.
- Exposes only a read-only upload-status endpoint; it does not expose Drive file listing, reading, downloading, updating, or deleting.
- Requires a researcher-generated participant upload code. Do not publish that code in the GitHub repository.

## Create and authorise the Apps Script project

1. Open [Google Apps Script](https://script.google.com/home/projects/create) while signed in to the Google account that should own the experiment data.
2. Name the project **English Experiment Drive Upload**.
3. Replace the contents of `Code.gs` with the contents of this folder's `Code.gs`.
4. In Apps Script, open **Project Settings** and enable **Show "appsscript.json" manifest file in editor**.
5. Open `appsscript.json` and replace it with the manifest in this folder.
6. Save the project.
7. Select `setupDriveFolder` in the function dropdown and click **Run**.
8. Review Google's authorisation prompt and grant the requested Drive and external-request permissions.
9. Open the execution log. It will show the private Drive destination folder and a random **Participant upload code**. Keep this code out of GitHub and share it privately with your participants. To retrieve it later, run `showUploadAccessCode`.

## Deploy the endpoint

1. Click **Deploy → New deployment**.
2. Select **Web app**.
3. Set **Execute as** to **Me** (the researcher account).
4. Set **Who has access** to **Anyone** (including people who are not signed in to Google).
5. Deploy and complete any additional Google authorisation prompt.
6. Copy the deployed URL ending in `/exec`.

The web app must be anonymously accessible because participants should not have to sign in to Google. It runs as the researcher, so uploaded files are created in the researcher's Drive. The participant upload code is required for POST requests.

## Important security note

This is a publicly reachable upload endpoint, protected by a separate study access code and strict operation/file-name/type/size checks. The code is shared privately with participants; it is not stored with their research responses. Anyone who obtains both the endpoint URL and the access code could submit files to the dedicated experiment folder, so do not publish the code. The endpoint has no methods for reading or deleting Drive files.

## Handoff

Send the researcher the deployed `/exec` URL through a private channel. Do not send the participant upload code in GitHub issues, public repository files, or other public locations.

The GitHub Pages page will be connected to the endpoint in a later step. Do not distribute the Apps Script URL as the experiment link; participants will continue to use the experiment page.
