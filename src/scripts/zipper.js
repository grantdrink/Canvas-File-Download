import JSZip from 'jszip';

console.log('zipper.js loaded');

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Received message:', message);
  if (message.action === 'zipAndDownload') {
    console.log('Starting zip process with downloads:', message.allDownloads);
    handleZipping(message.allDownloads);
  }
});

async function handleZipping(allDownloads) {
  console.log('Processing downloads for courses:', Object.keys(allDownloads));

  for (const [courseId, files] of Object.entries(allDownloads)) {
    console.log(`Creating zip for course ${courseId} with ${files.length} files`);
    const zip = new JSZip();

    for (const file of files) {
      try {
        console.log(`Requesting background fetch for file: ${file.filename}`);
        const blob = await fetchFileInBackground(file.href);

        if (!blob || blob.size === 0) {
          console.warn(`Blob is empty for ${file.filename}. Skipping...`);
          continue;
        }

        zip.file(file.filename, blob);
        console.log(`Added ${file.filename} to zip`);
      } catch (error) {
        console.warn(`Failed to fetch ${file.href}:`, error);
      }
    }

    console.log(`Generating zip for course ${courseId}`);
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const zipUrl = URL.createObjectURL(zipBlob);

    console.log(`Downloading zip for course ${courseId}`);
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = `Canvas_Course_${courseId}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    console.log(`Download initiated for course ${courseId}`);
  }

  console.log('✅ Zipping and downloading complete.');
}

// Fetch the file from the background script
async function fetchFileInBackground(url) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fetchFile', url }, (response) => {
      if (response && response.success) {
        resolve(response.blob);
      } else {
        reject(new Error(response ? response.error : 'Unknown error'));
      }
    });
  });
}
