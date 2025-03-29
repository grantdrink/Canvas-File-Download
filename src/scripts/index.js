document.addEventListener('DOMContentLoaded', async () => {
    const button = document.getElementById('runScript');
    const statusEl = document.getElementById('status');
  
    button.disabled = true;
    statusEl.textContent = '🔄 Checking login...';
  
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    fetch('https://bostoncollege.instructure.com/api/v1/users/self', {
      credentials: 'include'
    })
      .then(res => {
        if (res.ok) {
          console.log("✅ Canvas session is VALID.");
          statusEl.textContent = '✅ Logged into Canvas';
          statusEl.style.color = 'green';
          button.disabled = false;
        } else {
          console.warn("❌ Canvas session cookie exists but is INVALID (got", res.status, ")");
          statusEl.textContent = '❌ Not logged into Canvas';
          statusEl.style.color = 'red';
          button.disabled = true;
        }
      })
      .catch(err => {
        console.error("❌ Error checking session:", err);
        statusEl.textContent = '⚠️ Error checking login';
        statusEl.style.color = 'orange';
        button.disabled = true;
      });
    
  
    // Start scraping process
    button.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'startScraping' });
      statusEl.textContent = '🧠 Starting scrape...';
    });
  
    // Listen for updates from background script
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.statusUpdate) {
        statusEl.textContent = msg.statusUpdate;
      }
    });
  });
  