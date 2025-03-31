// background.js

// --- Log Collector Setup ---
const MAX_LOG_ENTRIES = 5000;
const backgroundLogs = [];

function log(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            try { return JSON.stringify(arg); } catch { return '[Unserializable Object]'; }
        } 
        return String(arg);
    }).join(' ');
    
    const logEntry = `${timestamp} [${level.toUpperCase()}] ${message}`;
    
    // Add to memory log (with limit)
    backgroundLogs.push(logEntry);
    if (backgroundLogs.length > MAX_LOG_ENTRIES) {
        backgroundLogs.shift(); // Remove the oldest entry
    }
    
    // Also log to the actual console
    switch (level) {
        case 'warn':
            console.warn(...args);
            break;
        case 'error':
            console.error(...args);
            break;
        default:
            console.log(...args);
            break;
    }
}

// Replace console calls throughout this script with log('info', ...), log('warn', ...), log('error', ...)
// Example:
// console.log("Background script loaded successfully."); -> log('info', "Background script loaded successfully.");
// console.error("Tab query error:", error); -> log('error', "Tab query error:", error);
// console.warn("Target tab closed."); -> log('warn', "Target tab closed.");

chrome.runtime.onInstalled.addListener(() => {
  log('info', "Background script installed/updated successfully.");
});

// Helper function to parse Content-Disposition header
function getFilenameFromHeader(header) {
    if (!header) return null;

    // Check for attachment; filename*=[charset]'[lang]'filename.ext (RFC 5987)
    const matchUtf8 = header.match(/filename\*=UTF-8''([^;\'\s]+)/i);
    if (matchUtf8 && matchUtf8[1]) {
        try {
            let filename = decodeURIComponent(matchUtf8[1]); 
            filename = filename.replace(/[\\/]/g, '_'); 
            return filename.trim();
        } catch (e) { log('error', "Error decoding filename* header:", e); }
    }
    
    // Check for attachment; filename="filename.ext"
    const matchSimple = header.match(/filename="([^"\\]*(?:\\.[^"\\]*)*)"/i);
    if (matchSimple && matchSimple[1]) {
         try {
            let filename = matchSimple[1]; 
            // Handle potential backslash escapes within quotes (less common)
            filename = filename.replace(/\\(.)/g, "$1"); 
            filename = filename.replace(/[\\/]/g, '_');
            return filename.trim();
         } catch (e) { log('error', "Error decoding simple filename header:", e); }
    }

    // Check for attachment; filename=filename.ext (no quotes)
    const matchUnquoted = header.match(/filename=([^;\s]+)/i);
    if (matchUnquoted && matchUnquoted[1]) {
         try {
            let filename = matchUnquoted[1];
            filename = filename.replace(/[\\/]/g, '_');
            return filename.trim();
         } catch (e) { log('error', "Error decoding unquoted filename header:", e); }
    }

    log('warn', "Could not parse filename from Content-Disposition header:", header);
    return null;
}


// Updated fetchFile function
async function fetchFile(url) {
    log('info', `Fetching file from URL: ${url}`);
    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow' // Explicitly follow redirects (default, but good to be clear)
        });

        if (!response.ok) {
             // Log detailed response status if fetch completed but wasn't OK
             log('error', `Fetch response not OK for ${url}. Status: ${response.status} ${response.statusText}`);
             const responseText = await response.text().catch(() => 'Could not read response body.'); // Try to get body text for context
             log('error', `Response body (if available): ${responseText.substring(0, 500)}`);
             throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
        }
        
        // Try to get filename from Content-Disposition header
        const disposition = response.headers.get('content-disposition');
        log('info', `Resp: Type=${response.headers.get('content-type') || 'N/A'}, Disp=${disposition || 'N/A'}`);
        let filenameFromHeader = null;
        if (disposition && disposition.includes('filename=')) {
            const filenameMatch = disposition.match(/filename\*?=(?:"|'')?([^;"']*)(?:"|'')?/i);
             if (filenameMatch && filenameMatch[1]) {
                 try {
                    // Handle potential URL encoding (UTF-8 or otherwise)
                    filenameFromHeader = decodeURIComponent(filenameMatch[1]);
                 } catch (e) {
                    log('warn', 'Could not decode filename from header:', filenameMatch[1], e);
                    filenameFromHeader = filenameMatch[1]; // Use raw value as fallback
                 }
                log('info', `Filename from header: ${filenameFromHeader}`);
            }
        }
        
        const blob = await response.blob();
        log('info', `Created blob size=${blob.size} type=${blob.type}`);
        
        // Define a maximum size for the Base64 string (e.g., 15 million chars ~ 11MB binary)
        const MAX_BASE64_LENGTH = 15 * 1024 * 1024; 

        // Convert blob to base64
        const base64String = await blobToBase64(blob);

        if (base64String === null) {
            // Handle error from blobToBase64 if it couldn't read the blob
            log('error', `BG: Failed to convert blob to Base64 for ${url}.`);
            // Treat this as a fetch failure
            throw new Error('Failed to convert blob to Base64.'); 
        }

        // --- Check Size --- 
        if (base64String.length > MAX_BASE64_LENGTH) {
            log('warn', `BG: File ${url} (Blob size ${blob.size}) resulted in Base64 length ${base64String.length}, exceeding limit ${MAX_BASE64_LENGTH}. Skipping content transfer.`);
            // Return success=true but indicate skipping due to size
            return { 
                success: true, 
                skipped: true, // Add a flag to indicate skipping
                error: 'File skipped: too large for messaging',
                filenameFromHeader: filenameFromHeader, // Still useful for logging
                contentType: blob.type
            };
        }
        // --- END Check Size ---

        log('info', `BG: Fetched OK. Header Filename=${filenameFromHeader || 'null'}, Type=${blob.type || 'N/A'}, Base64 Len=${base64String.length}`);
        
        // Return full data if size is okay
        return { 
            success: true, 
            skipped: false, // Explicitly mark as not skipped
            base64: base64String, 
            contentType: blob.type,
            filenameFromHeader: filenameFromHeader
        };

    } catch (error) {
        // This catch block now primarily handles network errors before fetch completes,
        // or errors during response processing (like .blob(), .text())
        // The .catch() in the message listener handles the overall promise rejection.
        log('error', `Error inside fetchFile function for ${url}:`, error.name, error.message);
        // Re-throw the error to be caught by the .catch() in the message listener
        throw error; 
    }
}

// Convert Blob to Base64 string
function blobToBase64(blob) {
  return new Promise((resolve) => { // Don't reject, resolve with null on error
    if (!blob || blob.size === undefined) {
         log('error', "Invalid blob provided to blobToBase64");
         return resolve(null);
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result?.split(',')[1] || null; // Handle null result
      resolve(base64);
    };
    reader.onerror = (error) => {
      log('error', 'Error reading blob:', error);
      resolve(null); // Resolve with null instead of rejecting
    };
    reader.readAsDataURL(blob);
  });
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'runScript') {
        log('info', 'BG: Received runScript request', message.coursesInfo);
        // Reset logs for the new run - Modify array in place
        backgroundLogs.length = 0; 
        log('info', 'BG: Cleared previous background logs.');
        orchestrateCanvasScraping(message.coursesInfo)
            .then(() => {
                log('info', 'BG: Orchestration complete.');
                // No need to send specific response here, orchestration handles sending final data
            })
            .catch(error => {
                log('error', 'BG: Orchestration failed critically:', error);
                sendStatus('❌ Critical error during scraping process.');
            });
        // Keep listener active? No need if orchestration sends final message.
        // return true; 
    } else if (message.action === 'downloadLogs') {
        // Keep the downloadLogs logic as is
        log('info', 'BG: Received request to download background logs.');
        if (backgroundLogs.length === 0) {
            log('warn', 'BG: No logs recorded yet to download.');
            sendResponse({ success: false, error: 'No logs recorded yet.' });
            return false; // No async response needed
        }

        try {
            const logText = backgroundLogs.map(entry => 
                `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ')}`
            ).join('\n');
            
            const blob = new Blob([logText], { type: 'text/plain' });
            log('info', `BG: Created log blob size=${blob.size}`);

            const reader = new FileReader();
            reader.onload = function(event) {
                const dataUrl = event.target.result;
                chrome.downloads.download({
                    url: dataUrl,
                    filename: 'canvas_download_background_logs.txt',
                    saveAs: true 
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        log('error', 'BG: Error starting log download:', chrome.runtime.lastError);
                        try { sendResponse({ success: false, error: `Failed to start download: ${chrome.runtime.lastError.message}` }); } catch(e) {} 
                    } else {
                        log('info', 'BG: Log download initiated successfully. ID:', downloadId);
                        try { sendResponse({ success: true }); } catch(e) {}
                    }
                });
            };
            reader.onerror = function(event) {
                 log('error', 'BG: Error reading log blob as Data URL:', event.target.error);
                 try { sendResponse({ success: false, error: 'Error reading log data.' }); } catch(e) {} 
            };
            reader.readAsDataURL(blob);

        } catch (error) {
            log('error', 'BG: Error preparing logs for download:', error);
             try { sendResponse({ success: false, error: `Error preparing logs: ${error.message}` }); } catch(e) {} 
        }
        return true; // Indicate async response is needed for FileReader
        
    } else if (message.action === 'fetchFile') {
        const url = message.url;
        log('info', `BG: Received fetchFile request: ${url}`);
        fetchFile(url) // Call the internal fetchFile function (which should still exist)
            .then(response => {
                // response should be { success: true, base64, contentType, filenameFromHeader }
                log('info', `BG: fetchFile successful for ${url}. Sending response back.`);
                sendResponse(response);
            })
            .catch(error => {
                // Handle errors, including specific CORS check
                log('error', `BG: fetchFile CRITICAL error for ${url}:`, error);
                let errorMessage = `Fetch failed: ${error.message}`;
                if (error instanceof TypeError && error.message === 'Failed to fetch') {
                    errorMessage += ". This often indicates a CORS policy violation, likely due to a redirect (e.g., to canvas-user-content.com) that blocks access from the extension's background script.";
                    log('warn', `BG: Suspected CORS failure for ${url}. The server likely blocked the request after a redirect.`);
                }
                log('warn', `BG: Sending failure response back for ${url}`);
                sendResponse({ success: false, error: errorMessage }); 
            });
        return true; // Indicate asynchronous response is needed here!
    }
    
    // Potentially handle other messages if needed
    return false; // Default to synchronous response if no action matched or async wasn't needed
});


// --- Orchestration Logic --- 

async function updateTabUrl(tabId, url) {
  log('info', `Updating tab ${tabId} URL to: ${url}`);
  await chrome.tabs.update(tabId, { url });
}

function waitForPageLoad(tabId) {
  return new Promise((resolve, reject) => {
    let timeoutId = setTimeout(() => {
        log('warn', `waitForPageLoad timeout for tab ${tabId}`);
        chrome.tabs.onUpdated.removeListener(listener); 
        reject(new Error(`Timeout waiting for page load on tab ${tabId}`));
    }, 30000); // 30 second timeout

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                 log('warn', `Tab ${tabId} closed or inaccessible during waitForPageLoad.`);
                 clearTimeout(timeoutId);
                 chrome.tabs.onUpdated.removeListener(listener);
                 return reject(new Error(`Tab ${tabId} closed or inaccessible.`));
            }
            if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) { 
                 log('info', `Page loaded for tab ${tabId}: ${tab.url}`);
                 clearTimeout(timeoutId);
                 chrome.tabs.onUpdated.removeListener(listener);
                 setTimeout(resolve, 1000); 
            } else {
                 log('info', `Waiting for non-internal URL for tab ${tabId}... Current: ${tab.url}`);
            }
        });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Modified scrapeDownloadLinks to handle the new return structure
async function scrapeDownloadLinks(tabId) { 
  log('info', `Injecting scrape.js into tab: ${tabId}.`);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/scripts/scrape.js']
    });
    
    if (results?.[0]?.result) {
        const scrapeResult = results[0].result;
        // Validate the expected structure
        if (scrapeResult && scrapeResult.directDownloads !== undefined && scrapeResult.intermediatePageLinks !== undefined) {
             log('info', `Scrape successful. Direct: ${scrapeResult.directDownloads.length}, Intermediate: ${scrapeResult.intermediatePageLinks.length}`);
             return scrapeResult; // Return the object { directDownloads: [], intermediatePageLinks: [] }
        } else {
             log('warn', 'scrape.js returned unexpected structure:', scrapeResult);
             return { directDownloads: [], intermediatePageLinks: [] }; // Return empty structure
        }
    } else {
        log('warn', 'scrape.js returned no results.', results);
        return { directDownloads: [], intermediatePageLinks: [] };
    }
  } catch (error) {
      log('error', `Error executing scrape.js on tab ${tabId}:`, error);
      // Don't propagate error, just return empty results
      return { directDownloads: [], intermediatePageLinks: [] }; 
  }
}

function sendStatus(text) {
  log('info', "Status:", text);
  chrome.runtime.sendMessage({ statusUpdate: text }).catch(error => {
      if (!error.message.includes("Could not establish connection")) {
          log('error', "Error sending status:", error);
      }
  });
}

async function orchestrateCanvasScraping(coursesInfo) {
    const allCourseDownloads = {}; // Structure: { courseId: { courseName: '...', files: [...] } }
    let totalFilesFound = 0;
    log('info', 'Starting scraping orchestration...');
    sendStatus('🚀 Starting scraper...');

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || tabs.length === 0) {
        log('error', 'No active tab found.');
        sendStatus('❌ No active tab found.');
        return;
    }
    const tabId = tabs[0].id;

    try {
        for (const course of coursesInfo) {
            const coursePath = course.path;
            const courseName = course.name;
            const courseId = coursePath.replace(new RegExp("courses\\/|\\/?$"), ''); 
            log('info', `\n******************* Course: ${courseName} (ID: ${courseId}) *******************`);
            
            // Use a Map for efficient deduplication of direct download links by href for this course
            const courseDirectDownloadsMap = new Map(); 

            // --- Process pages sequentially: Modules first, then Files ---
            for (const pageType of ['modules', 'files']) { 
                 const pageUrl = `https://bostoncollege.instructure.com/${coursePath}/${pageType}`;
                 log('info', `--- Processing ${pageType} page for ${courseName} ---`);
                 try {
                     sendStatus(`🧭 Navigating to ${pageType} for ${courseName}...`); 
                     await updateTabUrl(tabId, pageUrl);
                     await waitForPageLoad(tabId);
                     
                     const currentTabInfo = await chrome.tabs.get(tabId);
                     if (!currentTabInfo.url || !currentTabInfo.url.startsWith(pageUrl.split('?')[0])) {
                          log('warn', `Redirected away from ${pageType} page. Expected ~${pageUrl}, Got: ${currentTabInfo.url}`);
                          sendStatus(`⚠️ Couldn't access ${pageType} page for ${courseName}.`);
                          continue; 
                     }
                     
                     sendStatus(` scraping ${pageType} for ${courseName}...`);
                     const result = await scrapeDownloadLinks(tabId); // Scrape the main page (Modules or Files)
                     
                     // Add direct downloads found on this page
                     result.directDownloads.forEach(file => {
                         if (!courseDirectDownloadsMap.has(file.href)) {
                             log('info', ` Found DDL on ${pageType} page: ${file.filename} (${file.href.substring(0,60)}...)`);
                             courseDirectDownloadsMap.set(file.href, file);
                         }
                     });
                     log('info', ` ${pageType} page: Found ${result.directDownloads.length} direct links.`);

                     // --- *** Process Intermediate Pages IMMEDIATELY if found *** ---
                     if (result.intermediatePageLinks && result.intermediatePageLinks.length > 0) {
                         log('info', ` Found ${result.intermediatePageLinks.length} intermediate links on ${pageType} page. Processing now...`);
                         sendStatus(`Found ${result.intermediatePageLinks.length} item links on ${pageType}. Scraping them...`);

                         for (const intermediateInfo of result.intermediatePageLinks) {
                             const intermediateUrl = intermediateInfo.url;
                             const filenameHint = intermediateInfo.filenameHint; 
                             log('info', ` --> Navigating to intermediate page: ${intermediateUrl}`, filenameHint ? `(Hint: ${filenameHint})` : '');
                              try {
                                  // Basic skip for redundant files/modules links if they somehow sneak in
                                  if (intermediateUrl.match(/\/(files|modules)\/?$/)) {
                                     log('info', '  Skipping redundant scrape of files/modules page found as intermediate.'); continue;
                                  }
                                  await updateTabUrl(tabId, intermediateUrl);
                                  await waitForPageLoad(tabId);
                                  const intermediateTabInfo = await chrome.tabs.get(tabId);
                                  
                                  // --- Relaxed Navigation Check --- 
                                  // New check: Ensure we are still within the same course after potential redirect
                                  
                                  // Ensure coursePath ends with a slash for accurate startsWith check
                                  const coursePathWithSlash = coursePath.endsWith('/') ? coursePath : `${coursePath}/`;
                                  const expectedCourseBaseUrl = `https://bostoncollege.instructure.com/${coursePathWithSlash}`;
                                  
                                  if (!intermediateTabInfo.url || !intermediateTabInfo.url.startsWith(expectedCourseBaseUrl)) {
                                       log('warn', `  Navigation failed or redirected outside the course. Expected base: ${expectedCourseBaseUrl}, Got URL: ${intermediateTabInfo.url}`); 
                                       sendStatus(`⚠️ Problem navigating to item: ${filenameHint || intermediateUrl.split('/').pop()}`);
                                       continue;
                                  }
                                  
                                  // Scrape the intermediate page
                                  sendStatus(`   Scraping item: ${filenameHint || intermediateUrl.split('/').pop()}...`);
                                  const intermediateResult = await scrapeDownloadLinks(tabId); 
                                  
                                  // Process direct downloads found on this intermediate page
                                  intermediateResult.directDownloads.forEach(file => {
                                      if (!courseDirectDownloadsMap.has(file.href)) {
                                          // Use filenameHint if available, otherwise use the scraped filename
                                          let finalFilenameToUse = filenameHint || file.filename;
                                          finalFilenameToUse = finalFilenameToUse.replace(/[\/\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
                                          
                                          log('info', `    ----> Found DDL on intermediate page. URL: ${file.href.substring(0,60)}..., Using Filename: "${finalFilenameToUse}" (Hint: ${filenameHint ? 'Yes' : 'No'})`);
                                          
                                          // Store the actual download HREF but with the potentially hinted filename
                                          courseDirectDownloadsMap.set(file.href, { 
                                              href: file.href, 
                                              filename: finalFilenameToUse, 
                                              contentType: file.contentType 
                                          });
                                      }
                                  });
                                  if (intermediateResult.intermediatePageLinks.length > 0) log('warn', '  Found unexpected nested intermediate links on page:', intermediateUrl, intermediateResult.intermediatePageLinks);

                              } catch (intermediateError) {
                                  log('error', `  Error scraping intermediate page ${intermediateUrl}:`, intermediateError);
                                  sendStatus(`❌ Error scraping item: ${filenameHint || intermediateUrl.split('/').pop()}`);
                              }
                         } // End intermediate page loop
                         log('info', ` Finished processing intermediate links from ${pageType} page.`);
                     } else {
                         log('info', ` No intermediate pages found on ${pageType} page.`);
                     }

                 } catch (pageError) {
                     log('error', `Error processing ${pageType} page for ${courseName}:`, pageError);
                     sendStatus(`❌ Error on ${pageType} page for ${courseName}.`);
                 }
            } // End pageType loop (Modules -> Files)

            // --- Consolidate and Store Results for the Course ---
            const allFoundFiles = Array.from(courseDirectDownloadsMap.values());
            const internalFilesOnly = allFoundFiles.filter(file => {
                if (file.href && (file.href.startsWith('https://bostoncollege.instructure.com/') || file.href.startsWith('/'))) {
                    return true; // Keep internal Canvas links (or relative links assumed to be internal)
                } else {
                    log('warn', `Skipping external link for file "${file.filename}": ${file.href}`);
                    return false; // Filter out external links
                }
            });
            
            // Use the filtered list for storing and counting
            const finalFileList = internalFilesOnly; 
            
            if (finalFileList.length > 0) {
                const sanitizedCourseName = courseName.replace(/[\/\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
                const courseId = coursePath.replace(new RegExp("courses\\/|\\/?$"), ''); 
                allCourseDownloads[courseId] = { 
                    courseName: sanitizedCourseName || `Course_${courseId}`,
                    // Ensure we store href, filename, and potentially contentType if needed later
                    files: finalFileList.map(f => ({ 
                        href: f.href, 
                        filename: f.filename, 
                        contentType: f.contentType // Keep contentType just in case
                    })) 
                };
                totalFilesFound += finalFileList.length;
                log('info', `✅ Collected ${finalFileList.length} files total from ${courseName}`);
                sendStatus(`✅ Collected ${finalFileList.length} files from ${courseName}`);
            } else {
                 log('info', `No downloadable internal files found for ${courseName}.`);
                 sendStatus(`🤷 No files found for ${courseName}.`);
            }

            log('info', `******************* COMPLETED Course: ${courseName} *******************`);

        } // End loop through courses

        // --- FINAL STEP: Send data to zipper.js using zipAndDownload--- 
        if (Object.keys(allCourseDownloads).length > 0) {
            log('info', `--- Sending ALL (${totalFilesFound} files from ${Object.keys(allCourseDownloads).length} courses) collected data to zipper via zipAndDownload ---`);
            console.log('Final data structure for zipAndDownload:', JSON.stringify(allCourseDownloads, null, 2)); 
            sendStatus('✅ File collection complete. Asking zipper to prepare download(s)...'); // Update status
            try {
                await chrome.tabs.get(tabId); // Ensure tab exists
                // Send message to the content script (zipper.js) in the active tab
                await chrome.tabs.sendMessage(tabId, {
                    // Use the action name zipper.js was originally expecting
                    action: 'zipAndDownload', 
                    allDownloads: allCourseDownloads // Use the key zipper.js was originally expecting
                });
                log('info', 'BG: zipAndDownload message sent successfully to zipper.js.');
                // Zipper is now responsible for fetching status updates
            } catch (error) {
                 log('error', 'BG: Failed to send zipAndDownload message to zipper.js:', error);
                 if (error.message.includes('No tab with id') || error.message.includes('Receiving end does not exist')) {
                     log('warn', "Target tab likely closed before message could be sent.");
                     sendStatus('❌ Error: Tab closed before zipping could start.');
                 } else {
                    sendStatus('❌ Error sending file list to zipper.');
                 }
            }
        } else {
            log('info', 'No files found across all courses.');
            sendStatus('🏁 Finished. No files found to download.');
        }

    } catch (error) {
        log('error', 'Error during orchestration loop:', error);
        sendStatus('❌ Error during scraping process.');
    } finally {
        log('info', 'Scraping orchestration function finished.');
        // Maybe update status one last time if needed, though zipper should do final update
    }
}
