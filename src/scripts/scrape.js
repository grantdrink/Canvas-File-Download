(() => {
    console.log('Starting scrape.js on:', window.location.href);
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    console.log('Found total links with href:', allLinks.length);
    const directDownloads = [];
    const intermediatePageLinks = [];
    const seenIntermediateUrls = new Set();

    // --- Regex patterns ---
    const filePreviewRegex = /\/files\/(\d+)/; // Matches /files/#####
    const directDownloadKeywords = /\/download(\?|$)|\.(pdf|docx?|pptx?|xlsx?|zip|rar|jpg|png|mp4|txt|csv|ipynb)$/i;
    const pageLinkRegex = /\/(files|modules|assignments|quizzes|pages|announcements|discussions|conferences|collaborations|grades|people|outcomes|settings)\/?$/i; // Exclude main navigation/tool links
    const courseHomeRegex = /\/courses\/\d+\/?$/; // Exclude link to course home itself
    const moduleItemRegex = /\/modules\/items\/(\d+)/; // Specific regex for module items

    // --- Selectors for potential intermediate pages within modules/content ---
    // Links within module items that are NOT Files/Attachments, or any link inside user content
    const intermediateSelectors = [
        'li.context_module_item[data-item-type="Assignment"] a', // Links inside Assignment items
        'li.context_module_item[data-item-type="Page"] a',       // Links inside Page items
        'li.context_module_item[data-item-type="Quiz"] a',        // Links inside Quiz items
        'li.context_module_item[data-item-type="Discussion"] a', // Links inside Discussion items
        'li.context_module_item[data-item-type="ExternalUrl"] a',// Links inside External URL items (less likely files, but maybe)
        '.user_content a',                                         // Any link inside user-generated content
        '.wiki_content a'                                          // Any link inside wiki content
    ].join(', ');

    // --- Custom Logger for Scrape Script ---
    // This helps differentiate logs when viewing the main page console
    function logScrape(level, ...args) {
        const message = args.map(arg => {
            if (typeof arg === 'object' && arg !== null) {
                try { return JSON.stringify(arg); } catch { return '[Object]'; }
            }
            return String(arg);
        }).join(' ');
        console.log(`[SCRAPE] [${level.toUpperCase()}] ${message}`);
    }

    allLinks.forEach(link => {
        let originalHref = link.href;

        // Clean the URL - remove hash fragments
        const cleanHref = originalHref.split('#')[0];

        // --- Initial Filtering (Skip basic nav, JS links) ---
        const isExcludedPageLink = cleanHref.match(pageLinkRegex) || cleanHref.match(courseHomeRegex);
        const isExcludedNav = link.matches('.context_external_tool, .skip-nav, .nav-skip-link, .menu-item, .Button--primary'); // Added Button--primary common for non-downloads
        const isJavascriptLink = cleanHref.toLowerCase().startsWith('javascript:');
        if (isExcludedPageLink || isExcludedNav || isJavascriptLink || !cleanHref.startsWith('http')) {
            return;
        }

        // --- Classification (Simplified Logic) ---
        let downloadHref = cleanHref;
        let isPotentialDirectDownload = false;
        let isPotentialIntermediatePage = false;
        let filenameHint = null; // Potential filename from initial link
        let classificationSource = 'None';

        const hasDirectDownloadKeywords = cleanHref.match(directDownloadKeywords);
        const hasDownloadAttribute = link.hasAttribute('download');
        const previewMatch = cleanHref.match(filePreviewRegex);
        const moduleItemMatch = cleanHref.match(moduleItemRegex);

        if (hasDownloadAttribute) {
            isPotentialDirectDownload = true;
            classificationSource = 'Has Download Attr';
        } else if (hasDirectDownloadKeywords) {
            isPotentialDirectDownload = true;
            classificationSource = 'Has Keywords/Ext';
        } else if (previewMatch) {
            // Always convert preview links, assuming they lead to a downloadable file
            downloadHref = cleanHref.replace(/\/?$/, '') + '/download?download_frd=1';
            isPotentialDirectDownload = true;
            classificationSource = 'Is Preview Link';
        } else if (moduleItemMatch) {
            // --- THIS IS A MODULE ITEM LINK ---
            isPotentialIntermediatePage = true;
            classificationSource = 'Is Module Item Link';
            // Try to get filename hint from THIS link
            const title = link.getAttribute('title')?.trim();
            const textNode = Array.from(link.childNodes).find(n => n.nodeType === Node.TEXT_NODE)?.textContent.trim();
            const innerModuleTitle = link.querySelector('.ig-title')?.textContent.trim(); // Common class within module items
            filenameHint = title || innerModuleTitle || textNode;
            if (filenameHint) {
                filenameHint = filenameHint.trim().replace(/^[.]+/, '').replace(/[.]+$/, '').trim();
                logScrape('info', ` Got filename hint '${filenameHint}' from module item link: ${cleanHref}`);
            } else {
                logScrape('warn', ` Could not get filename hint from module item link: ${cleanHref}`);
            }
        } else if (link.matches(intermediateSelectors)) {
            isPotentialIntermediatePage = true;
            classificationSource = 'Matches Other Intermediate Selector';
            // No reliable filename hint here usually
        }

        logScrape('debug', `Link: ${cleanHref.substring(0, 80)}... Classified as: ${classificationSource}`);

        // --- Process potential direct download --- 
        if (isPotentialDirectDownload) {
            let baseFilename = '';
            let filenameSource = 'None';
            let successfullyProcessed = false;
            const downloadAttrValue = link.getAttribute('download');
            if (downloadAttrValue && typeof downloadAttrValue === 'string' && downloadAttrValue.length > 0 && downloadAttrValue !== 'true') { baseFilename = downloadAttrValue; filenameSource = 'Download Attr Value'; }
            else if (hasDownloadAttribute && typeof downloadAttrValue === 'string' && downloadAttrValue === 'true') { filenameSource = 'Download Attr (true)'; }
            if (!baseFilename) { const title = link.getAttribute('title')?.trim(); if (title && title.length > 0 && !title.toLowerCase().includes('module')) { baseFilename = title; filenameSource = 'Title Attr'; } }
            if (!baseFilename) { const span = link.querySelector('span.ef-name'); if (span) { const txt = span.textContent.trim(); if (txt) { baseFilename = txt; filenameSource = 'Inner Span'; } } }
            if (!baseFilename) {
                const linkText = Array.from(link.childNodes)
                                     .filter(node => node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE && !node.matches('.screenreader-only, .ui-icon, .lock_icon')))
                                     .map(node => node.textContent).join('').trim();
                if (linkText && linkText.length > 0 && !linkText.toLowerCase().startsWith('download') && !linkText.match(/^\d+$/)) { baseFilename = linkText; filenameSource = 'Link Text'; }
            }
            // Fallback last
            if (!baseFilename) {
                if (previewMatch?.[1]) { baseFilename = previewMatch[1]; filenameSource = 'Fallback (ID)'; }
                else { baseFilename = `file_${Date.now()}`; filenameSource = 'Fallback (Timestamp)'; }
                logScrape('warn', `Using fallback filename for direct link. Base: ${baseFilename}`);
            }

            // Clean Base & Determine Extension
            if (baseFilename) baseFilename = baseFilename.trim().replace(/^[.]+/, '').replace(/[.]+$/, '').trim();
            else { logScrape('warn', `Skipping direct link - empty baseFilename. Href: ${cleanHref}`); return; }

            const contentType = link.getAttribute('data-content-type') || link.getAttribute('type') || '';
            let determinedExtension = null;
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

            // Assemble Final Filename (Using fixed logic from previous step)
            let finalFilename = baseFilename;
            const extensionRegex = /\.([a-zA-Z0-9]{1,5})$/;
            const existingExtMatch = finalFilename.match(extensionRegex);
            if (!existingExtMatch) {
                if (determinedExtension) finalFilename += '.' + determinedExtension;
                else {
                    const urlExtMatch = downloadHref.match(extensionRegex);
                    if (urlExtMatch && urlExtMatch[1]) finalFilename += '.' + urlExtMatch[1];
                    else finalFilename += '.unknown';
                }
            }

            // Sanitize & Add
            let sanitizedFilename = finalFilename.replace(/[\/\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
            if (sanitizedFilename && sanitizedFilename !== '.' && sanitizedFilename.length > 0) {
                logScrape('info', '-> Adding DIRECT download link:', { href: downloadHref, filename: sanitizedFilename });
                directDownloads.push({ href: downloadHref, filename: sanitizedFilename, contentType });
                successfullyProcessed = true;
            } else { logScrape('warn', `Direct filename invalid after processing: ${finalFilename} -> ${sanitizedFilename}`); }

            if (!successfullyProcessed) logScrape('warn', `Could not process direct link. Href: ${cleanHref}`);
        }
        // --- Process potential intermediate page --- 
        else if (isPotentialIntermediatePage) {
            // Add to intermediate list, include filename hint if we got one
            const currentDomain = window.location.hostname;
            try {
                const linkUrl = new URL(cleanHref);
                if (linkUrl.hostname !== currentDomain || linkUrl.protocol !== window.location.protocol) {
                    logScrape('info', `Skipping intermediate link to different domain/protocol: ${cleanHref}`);
                    return; 
                }
                // Avoid adding duplicates
                if (!seenIntermediateUrls.has(cleanHref)) {
                    logScrape('info', '-> Adding INTERMEDIATE page link:', cleanHref, filenameHint ? `(Hint: ${filenameHint})` : '');
                    intermediatePageLinks.push({ url: cleanHref, filenameHint: filenameHint }); // Store as object
                    seenIntermediateUrls.add(cleanHref);
                }
            } catch (e) {
                logScrape('warn', `Invalid URL for intermediate link? ${cleanHref}`, e);
                return; 
            }
        }
    }); // End of forEach

    logScrape('info', `Found ${directDownloads.length} direct download links this pass.`);
    logScrape('info', `Found ${intermediatePageLinks.length} unique intermediate page links this pass.`);
    // Return both lists
    return {
        directDownloads: directDownloads,
        intermediatePageLinks: intermediatePageLinks // Send array of objects
    };
})();