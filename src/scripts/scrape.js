(() => {
    console.log('Starting scrape.js');
    // Select all links with an href attribute
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    console.log('Found total links with href:', allLinks.length);
    const downloadLinks = [];

    // --- Regex patterns ---
    const filePreviewRegex = /\/files\/(\d+)/; // Matches /files/#####
    const directDownloadRegex = /\/download(\?|$)|\.(pdf|docx?|pptx?|xlsx?|zip|rar|jpg|png|mp4|txt)$/i;
    const pageLinkRegex = /\/(files|modules|assignments|quizzes|pages|announcements|discussions|conferences|collaborations|grades|people|outcomes|settings)\/?$/i; // Exclude main navigation/tool links
    const courseHomeRegex = /\/courses\/\d+\/?$/; // Exclude link to course home itself

    allLinks.forEach(link => {
        let originalHref = link.href;

        // --- Initial Filtering --- 
        // Skip basic navigation/tool links, course home link, and javascript links
        const isExcludedPageLink = originalHref.match(pageLinkRegex) || originalHref.match(courseHomeRegex);
        const isExcludedNav = link.matches('.context_external_tool, .skip-nav, .nav-skip-link, .menu-item');
        const isJavascriptLink = originalHref.toLowerCase().startsWith('javascript:');
        if (isExcludedPageLink || isExcludedNav || isJavascriptLink) {
            // console.log('Skipping excluded/JS link:', originalHref);
            return; // Skip this link
        }

        // --- Determine if it's potentially a file to download ---
        let downloadHref = originalHref;
        let isPotentialFile = false;
        const previewMatch = originalHref.match(filePreviewRegex);
        const alreadyDirect = originalHref.match(directDownloadRegex);
        const parentModuleItem = link.closest('li.context_module_item, div.ig-row'); // Check if inside a module item
        const isMarkedAsFile = parentModuleItem?.matches('[data-item-type="File"], [data-item-type="Attachment"]') || link.matches('[data-item-type="File"], [data-item-type="Attachment"]');
        const hasDownloadAttribute = link.hasAttribute('download');
        const hasFileClass = link.matches('[class*="file"]') || link.parentElement?.matches('[class*="file"]'); // Check parent too
        const isInUserContent = link.closest('.user_content, .wiki_content'); // Inside general content areas?

        if (previewMatch && !alreadyDirect) {
            // Construct download link for preview pages
            downloadHref = originalHref + '/download?download_frd=1';
            console.log(`Identified file preview link: ${originalHref}. Constructed download link: ${downloadHref}`);
            isPotentialFile = true;
        } else if (alreadyDirect) {
            // Already looks like a direct download URL
            isPotentialFile = true;
        } else if (isMarkedAsFile || hasDownloadAttribute || hasFileClass || isInUserContent) {
            // Other strong indicators - might still be a preview link we missed
            isPotentialFile = true;
            // If it doesn't look direct, but has indicators, assume it *might* need /download appending
            if (!alreadyDirect && originalHref.includes('/files/') && !originalHref.includes('/download')) {
                console.log(`Link has file indicators but not /download, trying to append: ${originalHref}`);
                downloadHref = originalHref.replace(/\/?$/, '') + '/download?download_frd=1'; // Append robustly
            }
        }
        
        // --- Process if deemed a potential file ---
        if (isPotentialFile) {
            let filenameSource = 'None';
            let baseFilename = '';
            let determinedExtension = null;
            let successfullyProcessed = false;

            // --- Filename Extraction (Prioritized) ---
            // 1. Download Attribute
            const downloadAttr = link.getAttribute('download');
            if (!baseFilename && downloadAttr && downloadAttr.length > 0) {
                baseFilename = downloadAttr; filenameSource = 'Download Attribute';
            }
             // 2. Link Title Attribute
             if (!baseFilename) {
                 const linkTitle = link.getAttribute('title')?.trim();
                 if (linkTitle && linkTitle.length > 0 && !linkTitle.toLowerCase().includes('module') && !linkTitle.toLowerCase().includes('course navigation')) {
                     baseFilename = linkTitle; filenameSource = 'Link Title';
                 }
             }
            // 3. Inner Span (Common on /files page)
            if (!baseFilename) {
                const innerNameSpan = link.querySelector('span.ef-name');
                if (innerNameSpan) {
                    const innerText = innerNameSpan.textContent.trim();
                    if (innerText && innerText.length > 0) { baseFilename = innerText; filenameSource = 'Inner Span'; }
                }
            }
            // 4. Link Text (Cleaned)
            if (!baseFilename) {
                // Get text but ignore hidden elements often used for icons/status
                const linkText = Array.from(link.childNodes)
                                     .filter(node => node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !node.matches('.screenreader-only, .ui-icon')))
                                     .map(node => node.textContent)
                                     .join('').trim();
                if (linkText && linkText.length > 0 && !linkText.toLowerCase().startsWith('download') && !linkText.match(/^\d+$/)) {
                    baseFilename = linkText; filenameSource = 'Link Text';
                }
            }
            // 5. Fallback (File ID or Timestamp)
             if (!baseFilename) {
                if (previewMatch && previewMatch[1]) {
                    baseFilename = previewMatch[1]; 
                    filenameSource = 'Fallback (ID from Preview)';
                } else {
                    baseFilename = `file_${Date.now()}`; 
                    filenameSource = 'Fallback (Timestamp)';
                }
                console.log(`Using fallback filename logic. Base: ${baseFilename}`);
            }

            // --- Initial Clean of Base Filename ---
            if (baseFilename) {
                baseFilename = baseFilename.trim().replace(/^[.]+/, '').replace(/[.]+$/, '').trim();
            } else {
                 console.warn(`Skipping link - baseFilename is empty after extraction. Href: ${originalHref}`);
                 return; // Use return to skip forEach iteration
            }
            
            // --- Content Type & Extension Determination ---
            const contentType = link.getAttribute('data-content-type') || link.getAttribute('type') || ''; 
            if (contentType.includes('pdf')) determinedExtension = 'pdf';
            else if (contentType.includes('word')) determinedExtension = 'docx';
            else if (contentType.includes('powerpoint') || contentType.includes('presentation')) determinedExtension = 'pptx';
            else if (contentType.includes('excel') || contentType.includes('spreadsheet')) determinedExtension = 'xlsx';
            else if (contentType.includes('zip')) determinedExtension = 'zip';
            else if (contentType.includes('image/jp')) determinedExtension = 'jpg'; 
            else if (contentType.includes('image/png')) determinedExtension = 'png';
            else if (contentType.includes('image')) determinedExtension = 'jpg'; 
            else if (contentType.includes('video')) determinedExtension = 'mp4';
            else if (contentType.includes('text')) determinedExtension = 'txt';
            
            // --- Final Filename Assembly ---
            let finalFilename = baseFilename; 
            const hasExistingExtension = finalFilename.match(/\.([a-zA-Z0-9]{1,5})$/); // Limit extension length check

            if (!hasExistingExtension) {
                if (determinedExtension) {
                    finalFilename += '.' + determinedExtension;
                } else {
                    const urlExtMatch = downloadHref.match(/\.([a-zA-Z0-9]{1,5})(?:\?|$)/);
                    if (urlExtMatch && urlExtMatch[1]) {
                        finalFilename += '.' + urlExtMatch[1];
                         console.log(`Sniffed extension '.${urlExtMatch[1]}' from download URL.`);
                    } else {
                        finalFilename += '.unknown'; 
                        console.warn(`'${finalFilename}' lacks extension, none determined/sniffed. Appending '.unknown'.`);
                    }
                }
            } 
            // --- Sanitization & Final Validation ---
            let sanitizedFilename = finalFilename.replace(/[\/\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim(); // Replace invalid chars, collapse whitespace
            if (sanitizedFilename && sanitizedFilename !== '.' && sanitizedFilename.length > 0) {
                console.log('-> Adding valid link:', { downloadHref, finalFilename: sanitizedFilename, source: filenameSource });
                downloadLinks.push({ href: downloadHref, filename: sanitizedFilename, contentType });
                successfullyProcessed = true;
            } else {
                console.warn(`Filename invalid after assembly/sanitization. Original Base: '${baseFilename}', Final: '${finalFilename}'`);
            }

            if (!successfullyProcessed) {
                console.warn(`Skipping link. Could not determine valid filename/href. Source: ${filenameSource}, Href: ${originalHref}`);
            }
        } // End of if(isPotentialFile)
    }); // End of forEach

    console.log('Total valid download links identified:', downloadLinks.length, downloadLinks);
    return downloadLinks;
})();