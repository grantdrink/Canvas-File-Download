// Chrome Manifest v3 isolates service workers (background.js) and restricts file 
// handling and npm package access unless they're bundled properly. Offloading is a reasonable plan.

// Listens for messages from other parts of the extension (e.g., popup.js or content scripts)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startScraping') {
    orchestrateCanvasScraping();
  }
});

async function orchestrateCanvasScraping() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Step 1: Scrape the dashboard for course links
  const courseUrls = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Extracts all anchor tags and collects unique course URLs
      const links = Array.from(document.querySelectorAll('a'));
      const courses = new Set();

      links.forEach(link => {
        // Finds URLs that match "courses/{number}"
        const match = link.href.match(/courses\/\d+/);
      
        if (match) {
          const course = match[0].endsWith('/') ? match[0] : match[0] + '/';
          courses.add(course);
        }
      });

      return Array.from(courses);
    }
  });

  const coursePaths = courseUrls[0].result;
  console.log(`Found ${coursePaths.length} courses`, coursePaths);

  const allDownloads = {};

  for (const coursePath of coursePaths) {
    // Extracts course ID from URL
    const courseId = coursePath.replace(/courses\/|\/$/g, '');
    const downloads = [];

    // Navigate to /files page of the course
    await updateTabUrl(tab.id, `https://bostoncollege.instructure.com/${coursePath}files`);
    await waitForPageLoad(tab.id);
    await sendStatus(`📁 Scraping files for course: ${courseId}`);
    const files = await scrapeDownloadLinks(tab.id);
    downloads.push(...files);

    // Navigate to /modules
    await updateTabUrl(tab.id, `https://bostoncollege.instructure.com/${coursePath}modules`);
    await waitForPageLoad(tab.id);
    await sendStatus(`📦 Scraping modules for course: ${courseId}`);
    const moduleLinks = await scrapeDownloadLinks(tab.id);
    downloads.push(...moduleLinks);

     // Save downloads for each course
     allDownloads[courseId] = downloads;
     await sendStatus(`✅ Collected ${downloads.length} files from ${courseId}`);
   }
 
   // Send all downloads to zipper.js
   console.log('Sending downloads to zipper.js:', allDownloads);
   try {
     await chrome.tabs.sendMessage(tab.id, { action: 'zipAndDownload', allDownloads });
     console.log('Message sent successfully to tab:', tab.id);
   } catch (error) {
     console.error('Failed to send message to tab:', error);
   }
 
   await sendStatus('🎉 All downloads sent to zipper.js for zipping!');
 }


// Update the tab URL to a new page
async function updateTabUrl(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

// Waits for the page to fully load before proceeding
function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2000); // 2 second wait
      }
    });
  });
}

// Injects the scrape.js file to extract download links
async function scrapeDownloadLinks(tabId) {
  console.log('Scraping download links for tab:', tabId);
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/scripts/scrape.js']
  });
  console.log('Found download links:', result[0].result);
  // Returns the scraped file links
  return result[0].result;
}

function sendStatus(text) {
  chrome.runtime.sendMessage({ statusUpdate: text });
}
