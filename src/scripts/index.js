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
    

    // Function to find courses on the current page
    async function findCoursesOnPage(tabId) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                    const foundCourses = [];
                    const courseRegex = new RegExp("courses\\/(\\d+)"); 
                    // Selectors for dashboard cards and course list links
                    const selectors = 'a.ic-DashboardCard__link, a.fOyUs_bGBk, .course-list-course-title-link'; 
                    document.querySelectorAll(selectors).forEach(link => {
                        const match = link.href.match(courseRegex);
                        if (match && match[0]) {
                            let name = link.getAttribute('aria-label') || link.querySelector('.ic-DashboardCard__header-title')?.textContent || link.textContent || `Course ${match[1]}`;
                            name = name.replace(/^(Course|Enroll in) *:? */i, '').replace(/ \(\d+\)$/, '').trim(); // Clean up name
                            foundCourses.push({ path: match[0], name: name });
                        }
                    });
                    
                    // Also check if currently on a course page
                    const currentMatch = window.location.pathname.match(courseRegex);
                    if (currentMatch && currentMatch[0]) {
                        const breadcrumbLink = document.querySelector('#breadcrumbs ul li:last-child a');
                        const pageTitle = document.title;
                        let currentName = breadcrumbLink?.textContent || pageTitle || `Course ${currentMatch[1]}`;
                        currentName = currentName.split(' - ')[0].split('|')[0].trim();
                        // Add if not already found via dashboard/list
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
            return results?.[0]?.result || [];
        } catch (error) {
            console.error("Error executing script to find courses:", error);
            statusEl.textContent = '❌ Error finding courses on page.';
            return []; // Return empty on error
        }
    }

    // Start scraping process - Updated event listener
    button.addEventListener('click', async () => { // Make listener async
      if (!tab || !tab.id) {
          statusEl.textContent = '❌ Cannot find active tab.';
          return;
      }
      
      statusEl.textContent = '🔍 Finding courses...';
      button.disabled = true; // Disable button while finding/running
      
      const coursesInfo = await findCoursesOnPage(tab.id);
      
      if (!coursesInfo || coursesInfo.length === 0) {
          statusEl.textContent = '⚠️ No courses found on this page.';
          button.disabled = false; // Re-enable button
          return;
      }
      
      statusEl.textContent = `✅ Found ${coursesInfo.length} course(s). Starting scrape...`;
      console.log('Popup: Sending runScript with courses:', coursesInfo);
      
      // Send the CORRECT message structure to background.js
      chrome.runtime.sendMessage({ 
          action: 'runScript', 
          coursesInfo: coursesInfo // Include the found courses
      }).catch(err => {
           console.error("Popup: Error sending runScript message:", err);
           statusEl.textContent = '❌ Error starting scrape.';
           button.disabled = false; // Re-enable on error
      });
      
      // Keep button disabled while background runs
      // Status updates will come via the listener below
    });
  
    // Listen for status updates from background script (existing code)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.statusUpdate) {
        statusEl.textContent = msg.statusUpdate;
        // Re-enable button ONLY if status indicates completion or fatal error
        if (msg.statusUpdate.startsWith('🏁') || msg.statusUpdate.startsWith('❌') || msg.statusUpdate.startsWith('🤷') || msg.statusUpdate.startsWith('⚠️')) {
            button.disabled = false;
        } else {
            button.disabled = true; // Keep disabled during processing
        }
      }
    });
  });
  