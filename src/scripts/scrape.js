(() => {
    console.log('Starting scrape.js');
    const allLinks = Array.from(document.querySelectorAll('a'));
    console.log('Found total links:', allLinks.length);
    const downloadLinks = [];
  
    allLinks.forEach(link => {
      const href = link.href;
      const isDownload = (
        href.includes('download') ||
        link.textContent.toLowerCase().includes('download') ||
        href.match(/\.(pdf|docx?|pptx?|xlsx?|zip|rar|jpg|png|mp4|txt)$/i)
      );
  
      if (isDownload) {
        console.log('Found download link:', {
          href,
          text: link.textContent,
          isDownload: true
        });
        downloadLinks.push({
          href,
          filename: decodeURIComponent(href.split('/').pop().split('?')[0])
        });
      }
    });
  
    console.log('Total download links found:', downloadLinks.length);
    return downloadLinks;
  })();