// background.js
chrome.runtime.onInstalled.addListener(() => {
  console.log("Background script loaded successfully.");
});

// Helper function to parse Content-Disposition header
function getFilenameFromHeader(header) {
    if (!header) return null;

    // Check for attachment; filename*=[charset]'[lang]'filename.ext (RFC 5987)
    const matchUtf8 = header.match(/filename\*=UTF-8''([^;\'\s]+)/i);
    if (matchUtf8 && matchUtf8[1]) {
        try {
            let filename = decodeURIComponent(matchUtf8[1]); 
            filename = filename.replace(/[\\\\/]/g, '_'); 
            return filename.trim();
        } catch (e) { console.error("Error decoding filename* header:", e); }
    }
    
    // Check for attachment; filename="filename.ext"
    const matchSimple = header.match(/filename="([^"\\]*(?:\\.[^"\\]*)*)"/i);
    if (matchSimple && matchSimple[1]) {
         try {
            let filename = matchSimple[1]; 
            // Handle potential backslash escapes within quotes (less common)
            filename = filename.replace(/\\(.)/g, "$1"); 
            filename = filename.replace(/[\\\\/]/g, '_');
            return filename.trim();
         } catch (e) { console.error("Error decoding simple filename header:", e); }
    }

    // Check for attachment; filename=filename.ext (no quotes)
    const matchUnquoted = header.match(/filename=([^;\s]+)/i);
    if (matchUnquoted && matchUnquoted[1]) {
         try {
            let filename = matchUnquoted[1];
            filename = filename.replace(/[\\\\/]/g, '_');
            return filename.trim();
         } catch (e) { console.error("Error decoding unquoted filename header:", e); }
    }

    console.warn("Could not parse filename from Content-Disposition header:", header);
    return null;
}


// Updated fetchFile function
async function fetchFile(url) {
    console.log('Fetching file from URL:', url);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': navigator.userAgent,
                'Referer': 'https://bostoncollege.instructure.com/' 
            }
        });
        if (!response.ok) throw new Error(`Failed: ${response.status} ${response.statusText}`);

        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        const contentDisposition = response.headers.get('content-disposition');
        console.log(`Resp: Type=${contentType}, Disp=${contentDisposition}`);

        const filenameFromHeader = getFilenameFromHeader(contentDisposition);
        console.log(`Filename from header: ${filenameFromHeader}`);

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength === 0) console.warn('Downloaded file is empty (0 bytes)');

        const blob = new Blob([arrayBuffer], { type: contentType });
        console.log(`Created blob size=${blob.size} type=${blob.type}`);
        return { blob, contentType, filenameFromHeader }; // Return all info
    } catch (error) {
        console.error(`Error fetching ${url}:`, error);
        throw error;
    }
}

// Convert Blob to Base64 string
function blobToBase64(blob) {
  return new Promise((resolve) => { // Don't reject, resolve with null on error
    if (!blob || blob.size === undefined) {
         console.error("Invalid blob provided to blobToBase64");
         return resolve(null);
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result?.split(',')[1] || null; // Handle null result
      resolve(base64);
    };
    reader.onerror = (error) => {
      console.error('Error reading blob:', error);
      resolve(null); // Resolve with null instead of rejecting
    };
    reader.readAsDataURL(blob);
  });
}


// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'startScraping') {
        orchestrateCanvasScraping();
        return false; // No async response needed here
    }

    if (message.action === 'fetchFile') {
        console.log(`BG: Received fetchFile request: ${message.url}`);
        fetchFile(message.url)
            .then(({ blob, contentType, filenameFromHeader }) => {
                return blobToBase64(blob).then(base64 => {
                    if (base64 === null) {
                        console.error(`BG: Failed to convert blob: ${message.url}`);
                        return sendResponse({ success: false, error: `Failed to process blob` });
                    }
                    console.log(`BG: Fetched OK. Header Filename=${filenameFromHeader}, Type=${contentType}, Base64 Len=${base64.length}`);
                    sendResponse({ success: true, blob: base64, contentType, filenameFromHeader });
                });
            })
            .catch((error) => {
                console.error(`BG: fetchFile error: ${message.url}`, error);
                sendResponse({ success: false, error: `Fetch failed: ${error.message}` });
            });
        return true; // Indicate async response
    }
    return false; // Default for other messages
});


// --- Orchestration Logic --- (Includes Regex Fixes) ---

async function updateTabUrl(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

function waitForPageLoad(tabId) {
  return new Promise((resolve, reject) => {
    let timeoutId = setTimeout(() => {
        console.warn(`waitForPageLoad timeout for tab ${tabId}`);
        chrome.tabs.onUpdated.removeListener(listener); 
        reject(new Error(`Timeout waiting for page load on tab ${tabId}`));
    }, 30000); // 30 second timeout

    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.get(tabId, (tab) => {
            // Check if tab still exists and URL is valid
            if (chrome.runtime.lastError || !tab) {
                 console.warn(`Tab ${tabId} closed or inaccessible during waitForPageLoad.`);
                 clearTimeout(timeoutId);
                 chrome.tabs.onUpdated.removeListener(listener);
                 return reject(new Error(`Tab ${tabId} closed or inaccessible.`));
            }
            if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) { 
                 console.log(`Page loaded for tab ${tabId}: ${tab.url}`);
                 clearTimeout(timeoutId);
                 chrome.tabs.onUpdated.removeListener(listener);
                 // Short delay after load complete, might help dynamic content
                 setTimeout(resolve, 1000); 
            } else {
                 console.log(`Waiting for non-internal URL for tab ${tabId}... Current: ${tab.url}`);
            }
        });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}


async function scrapeDownloadLinks(tabId) {
  console.log(`Injecting scrape.js into tab: ${tabId}`);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/scripts/scrape.js']
    });
    if (results && results[0] && results[0].result) {
        console.log(`Scrape successful, found ${results[0].result.length} links.`);
        return results[0].result;
    } else {
        console.warn(`scrape.js returned no results.`, results);
        return [];
    }
  } catch (error) {
      console.error(`Error executing scrape.js on tab ${tabId}:`, error);
       if (error.message.includes('Cannot access') || error.message.includes('extension context invalidated')) {
            console.warn(`Cannot scrape page (internal or invalid context).`);
       }
      return [];
  }
}

function sendStatus(text) {
  console.log("Status:", text);
  chrome.runtime.sendMessage({ statusUpdate: text }).catch(error => {
      if (!error.message.includes("Could not establish connection")) {
          console.error("Error sending status:", error);
      }
  });
}

async function orchestrateCanvasScraping() {
    let currentTab;
    try {
        [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!currentTab?.id) throw new Error("Could not get active tab.");
        console.log(`Starting scrape on tab ${currentTab.id}, URL: ${currentTab.url}`);
    } catch (error) {
        console.error("Tab query error:", error);
        return sendStatus("❌ Error: Could not get active tab.");
    }
    const tabId = currentTab.id;

    if (!currentTab.url || !currentTab.url.includes('instructure.com')) {
        return sendStatus("❌ Error: Not on Canvas. Navigate to Canvas first.");
    }

    // --- Find Courses and Names --- 
    let coursesInfo = []; // Will store { path: string, name: string } objects
    try {
        sendStatus("🔍 Finding courses & names...");
        const courseResults = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                const foundCourses = [];
                // Regex needs double backslashes when inside a string for injection
                const courseRegex = new RegExp("courses\\/(\\d+)"); 
                
                // Selectors for typical course links on Dashboard/Course List
                const selectors = 'a.ic-DashboardCard__link, a.fOyUs_bGBk, .course-list-course-title-link'; 
                
                document.querySelectorAll(selectors).forEach(link => {
                    const match = link.href.match(courseRegex);
                    if (match && match[0]) {
                        let name = link.getAttribute('aria-label') || link.textContent || `Course ${match[1]}`;
                        // More robust cleaning for names (escape backslashes in regex within string)
                        name = name.replace(new RegExp("Course\\s*:?", "i"), '').replace(/\(\d+\)$/, '').trim();
                        foundCourses.push({ path: match[0], name: name });
                    }
                });

                // Add current course if on a course page
                const currentMatch = window.location.pathname.match(courseRegex);
                if (currentMatch && currentMatch[0]) {
                    const breadcrumbLink = document.querySelector('#breadcrumbs ul li:last-child a');
                    const pageTitle = document.title;
                    let currentName = breadcrumbLink?.textContent || pageTitle || `Course ${currentMatch[1]}`;
                    currentName = currentName.split(' - ')[0].split('|')[0].trim(); // Clean title suffixes
                    if (!foundCourses.some(c => c.path === currentMatch[0])) {
                        foundCourses.push({ path: currentMatch[0], name: currentName });
                    }
                }

                // Deduplicate based on path
                const uniqueCourses = [];
                const seenPaths = new Set();
                for (const course of foundCourses) {
                    if (!seenPaths.has(course.path)) {
                        uniqueCourses.push(course);
                        seenPaths.add(course.path);
                    }
                }
                return uniqueCourses;
            }
        });

        coursesInfo = courseResults?.[0]?.result || [];
        if (coursesInfo.length === 0) {
            return sendStatus("⚠️ No course links/names found. Navigate to Dashboard or Course.");
        }
        console.log(`Found ${coursesInfo.length} potential courses:`, coursesInfo);
        sendStatus(`✅ Found ${coursesInfo.length} courses. Starting scrape...`);
    } catch (error) {
         console.error("Error finding course links/names:", error);
         // Check for injection errors specifically
         if (error.message.includes('Could not establish connection') || error.message.includes('Cannot access')) {
             sendStatus("❌ Error: Couldn't inject script. Try reloading the page or extension.");
         } else {
             sendStatus("❌ Error finding course info.");
         }
         return; // Stop execution if finding courses fails
    }
    
    const allDownloads = {}; // Structure: { courseId: { courseName: string, files: [...] } }
    let totalFilesScraped = 0;

    // Outer loop iterates through discovered courses
    for (const course of coursesInfo) {
        const coursePath = course.path;
        const courseName = course.name;
        // Correct regex escaping for replace method
        const courseId = coursePath.replace(new RegExp("courses\\/|\\/?$"), ''); 
        console.log(`*******************************************`);
        console.log(`STARTING Course: ${courseName} (ID: ${courseId})`);
        console.log(`*******************************************`);
        
        let downloadsForCourse = [];
        let courseProcessingError = false; 

        try {
            // Inner loop for page types (Files, Modules)
            for (const pageType of ['files', 'modules']) { 
                 const pageUrl = `https://bostoncollege.instructure.com/${coursePath}/${pageType}`;
                 console.log(`Attempting to process ${pageType} page for ${courseId}...`);
                 try {
                     sendStatus(`🧭 Navigating to ${pageType} for ${courseName}...`); 
                     await updateTabUrl(tabId, pageUrl);
                     await waitForPageLoad(tabId);
                     
                     const currentTabInfo = await chrome.tabs.get(tabId);
                     // Stricter check to ensure we are on the target page
                     if (!currentTabInfo.url || !currentTabInfo.url.startsWith(pageUrl)) {
                          console.warn(`Failed to navigate or redirected away from ${pageType} page for ${courseName}. Expected: ${pageUrl}, Got: ${currentTabInfo.url}`);
                          sendStatus(`⚠️ Couldn't access ${pageType} page for ${courseName}.`);
                          continue; 
                     }
                     
                     sendStatus(` scraping ${pageType} for ${courseName}...`);
                     const links = await scrapeDownloadLinks(tabId);
                     if (links && links.length > 0) {
                        downloadsForCourse.push(...links);
                        console.log(`Found ${links.length} links on ${pageType} page for ${courseName}.`);
                     } else {
                         console.log(`No links returned from scrape on ${pageType} page for ${courseName}.`);
                     }
                 } catch (pageError) {
                     console.error(`Error processing ${pageType} page for ${courseName} (ID: ${courseId}):`, pageError);
                     sendStatus(`❌ Error on ${pageType} page for ${courseName}.`);
                     // Consider marking courseProcessingError = true here if needed
                 }
            } // End inner pageType loop

            // Process downloads
            if (!courseProcessingError && downloadsForCourse.length > 0) {
                const uniqueDownloads = downloadsForCourse.filter((file, index, self) =>
                    index === self.findIndex((f) => (f.href === file.href))
                );
                if (uniqueDownloads.length > 0) {
                    allDownloads[courseId] = { 
                        courseName: courseName, 
                        files: uniqueDownloads 
                    };
                    totalFilesScraped += uniqueDownloads.length;
                    sendStatus(`✅ Collected ${uniqueDownloads.length} files from ${courseName}`);
                } else {
                     console.log(`No unique files found for ${courseName} after deduplication.`);
                }
            } else if (downloadsForCourse.length === 0 && !courseProcessingError) {
                 console.log(`No files found for course ${courseName} (ID: ${courseId}).`);
            } else {
                console.log(`Skipping download collection for ${courseName} due to processing error or no files found.`);
            }
        
        } catch (outerLoopError) {
             console.error(`CRITICAL ERROR during course loop for ${courseName} (ID: ${courseId}):`, outerLoopError);
             sendStatus(`❌ Critical error processing ${courseName}. Moving to next.`);
        }

        console.log(`*******************************************`);
        console.log(`COMPLETED Course: ${courseName} (ID: ${courseId})`);
        console.log(`*******************************************`);

    } // End outer course loop

    // --- Send to Zipper --- 
    if (Object.keys(allDownloads).length > 0) {
        console.log(`--- Sending ALL collected data to zipper ---`);
        console.log(`Total files: ${totalFilesScraped}. Courses: ${Object.keys(allDownloads).length}.`);
        // Log the actual data structure being sent
        console.log("Data structure sent:", JSON.stringify(allDownloads, null, 2)); 
        try {
            // Ensure the target tab still exists before sending
            await chrome.tabs.get(tabId); 
            await chrome.tabs.sendMessage(tabId, { action: 'zipAndDownload', allDownloads });
            console.log('Message sent to zipper.js successfully.');
            sendStatus('📦 Preparing zip files...');
        } catch (error) {
            console.error('Failed to send final message to zipper.js:', error);
             if (error.message.includes('No tab with id') || error.message.includes('Receiving end does not exist')) {
                 console.warn("Target tab was closed before message could be sent.");
                 sendStatus('❌ Error: Tab closed before zipping could start.');
             } else {
                 sendStatus('❌ Error sending files for zipping.');
             }
        }
    } else {
         console.log("Scraping complete. No files found in any course to send to zipper.");
         sendStatus('🏁 No downloadable files found.');
    }
}
