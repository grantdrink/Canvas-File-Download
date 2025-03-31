// zipper.js
import JSZip from 'jszip';

console.log('zipper.js loaded and ready.');

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Log ALL incoming messages to zipper.js
    console.log('Zipper: Received message:', message);

    if (message.action === 'zipAndDownload') {
        if (!message.allDownloads || Object.keys(message.allDownloads).length === 0) {
            console.warn("Zipper: Received zipAndDownload command but no downloads were provided.");
            // Optionally send a status back to the user via popup?
            chrome.runtime.sendMessage({ statusUpdate: "🏁 No files found to zip." }).catch(()=>{});
            return;
        }
        console.log('Zipper: Starting zip process with downloads:', message.allDownloads);
        handleZipping(message.allDownloads);
    }
});

async function handleZipping(allDownloads) {
    console.log('Zipper: Processing downloads for courses:', Object.keys(allDownloads));
    let totalZippedFiles = 0;
    let totalErrors = 0;

    // The keys of allDownloads are course IDs
    for (const courseId of Object.keys(allDownloads)) {
        // Get the course data object for this ID
        const courseData = allDownloads[courseId];
        if (!courseData || !courseData.files || courseData.files.length === 0) {
            console.log(`Skipping course ID ${courseId} - no files listed or data missing.`);
            continue;
        }

        // Extract course name and files list
        const courseName = courseData.courseName || `Course_${courseId}`; // Fallback name
        const files = courseData.files;
        
        // Sanitize course name for folder/file naming
        const sanitizedCourseName = courseName.replace(/[\/\:*?"<>|]/g, '_').trim();
        const zipFilename = `Canvas_${sanitizedCourseName}.zip`; // Name of the final zip file
        const folderNameInZip = sanitizedCourseName; // Name of the folder inside the zip

        console.log(`Zipper: Creating zip for course "${sanitizedCourseName}" (ID: ${courseId}) with ${files.length} files`);
        const zip = new JSZip();
        const courseFolder = zip.folder(folderNameInZip); // Create folder with sanitized course name
        let filesAddedToCourseZip = 0;

        for (const fileInfo of files) {
            try {
                console.log(`Zipper: Requesting file data for: ${fileInfo.filename} (Href: ${fileInfo.href})`);
                const response = await fetchFileFromBackground(fileInfo.href);
                
                // --- Check for skip flag --- 
                if (response?.skipped) {
                    console.warn(`Zipper: Skipping file ${fileInfo.filename} because it was too large (reported by background).`);
                    // Increment error count or a separate skipped count if desired
                    totalErrors++; 
                    continue; // Move to the next file
                }
                // --- END Check for skip flag ---
                
                // Proceed if not skipped and successful
                if (!response?.success) throw new Error(response?.error || 'Unknown fetch error');

                // Use response.base64
                const arrayBuffer = base64ToArrayBuffer(response.base64); 
                
                if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                    console.warn(`Zipper: Empty or invalid file data received for ${fileInfo.filename}. Skipping.`);
                    totalErrors++; continue;
                }
                
                // --- Determine filename (Header > Scraped) --- 
                let finalFilename = response.filenameFromHeader || fileInfo.filename;
                if (!finalFilename) { // Should not happen often with scrape.js fallbacks
                     console.warn(`Missing filename entirely for ${fileInfo.href}. Using fallback.`);
                     finalFilename = fileInfo.href.split('/').pop().split('?')[0] || `file_${Date.now()}`;
                }
                
                // --- Sanitize filename ---
                let sanitizedFilename = finalFilename.trim().replace(/^[.]+/, '').replace(/[.]+$/, '').trim(); 
                sanitizedFilename = sanitizedFilename.replace(/[\/\:*?"<>|]/g, '_');
                if (!sanitizedFilename || sanitizedFilename === '.') {
                     console.warn(`Filename invalid after sanitization ('${finalFilename}' -> '${sanitizedFilename}'). Using generic name.`);
                     sanitizedFilename = `file_${Date.now()}.unknown`; // More robust fallback
                }
                
                console.log(`Zipper: Adding "${sanitizedFilename}" (Size: ${arrayBuffer.byteLength}) to folder "${folderNameInZip}"`);
                courseFolder.file(sanitizedFilename, arrayBuffer, { binary: true }); 
                filesAddedToCourseZip++;

            } catch (error) {
                console.error(`Zipper: Failed processing ${fileInfo.filename || fileInfo.href}:`, error);
                totalErrors++;
            }
        } // End file loop

        // Generate and trigger download for this course's zip
        if (filesAddedToCourseZip > 0) {
            console.log(`Zipper: Generating zip for "${sanitizedCourseName}"...`);
            try {
                const zipBlob = await zip.generateAsync({ 
                    type: 'blob', 
                    mimeType: 'application/zip' 
                }); 
                console.log(`Zipper: Generated zip size for "${sanitizedCourseName}":`, zipBlob.size);
                triggerDownload(zipBlob, zipFilename); 
                totalZippedFiles += filesAddedToCourseZip;
            } catch (zipError) {
                 console.error(`Zipper: Failed zip generation for "${sanitizedCourseName}":`, zipError);
                 totalErrors++;
            }
        } else {
             console.log(`Zipper: No files added for "${sanitizedCourseName}". Skipping zip generation.`);
        }

    } // End course loop

    console.log(`Zipper: Processing complete. Total zipped: ${totalZippedFiles}. Errors: ${totalErrors}.`);
    chrome.runtime.sendMessage({ statusUpdate: `🏁 Complete! Zipped ${totalZippedFiles} files. ${totalErrors > 0 ? `${totalErrors} errors.` : ''}` }).catch(()=>{});
}

// --- Restore the manual download trigger function --- 
function triggerDownload(blob, filename) {
    // (This implementation uses URL.createObjectURL and simulates a click)
    if (!blob) {
        console.error("triggerDownload error: blob is null or undefined");
        return;
    }
    const zipUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none'; // Hide the link
    a.href = zipUrl;
    a.download = filename;
    console.log(`Zipper: Initiating download for ${filename} using createObjectURL.`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke the object URL after a short delay to allow the download to start
    setTimeout(() => URL.revokeObjectURL(zipUrl), 1000); 
}

// Updated function to request file data AND metadata from background
async function fetchFileFromBackground(url) {
    console.log(`Zipper: Requesting fetchFile message for URL: ${url}`); // Corrected template literal
    return new Promise((resolve, reject) => { // Keep reject for clarity here
        chrome.runtime.sendMessage({ action: 'fetchFile', url }, (response) => {
            if (chrome.runtime.lastError) {
                console.error(`Zipper: Runtime error sending/receiving message for ${url}:`, chrome.runtime.lastError);
                return reject(new Error(`Runtime error: ${chrome.runtime.lastError.message}`));
            }

            console.log(`Zipper: Received response from background for ${url}: Success=${response?.success}`);
            if (response && response.success) {
                 // Resolve with the whole response object including filenameFromHeader and contentType
                resolve(response); 
            } else {
                const errorMessage = response ? response.error : 'No response or unknown error from background script';
                console.error(`Zipper: Background script failed for ${url}: ${errorMessage}`);
                // Reject with an error object containing the message
                reject(new Error(errorMessage)); 
            }
        });
    });
}

// Convert base64 string to an ArrayBuffer
function base64ToArrayBuffer(base64) {
  if (!base64) return null;
  try {
      const binaryString = window.atob(base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
  } catch (e) {
      console.error("Error in base64ToArrayBuffer:", e);
      return null;
  }
}

/*
// --- Remove or comment out the saveAs version --- 
function triggerDownloadWithSaveAs(blob, filename) {
    // ... saveAs implementation ...
}
*/