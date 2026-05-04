const { ipcRenderer } = require('electron');
const i18n = require('../shared/i18n');
const { getLanguage } = require('../shared/config');

// Initialize language.
const lang = getLanguage();
i18n.init(lang);

// Check URL parameters.
const urlParams = new URLSearchParams(window.location.search);
const isBlackMode = urlParams.get('black') === '1';

if (isBlackMode) {
    // Hide everything for black mode.
    document.addEventListener('DOMContentLoaded', () => {
        const container = document.getElementById('container');
        const overlay = document.getElementById('overlay');
        if (container) container.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        document.body.style.backgroundColor = 'black';
    });
} else {
    // Translate labels.
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('label-pending').innerText = i18n.t('screensaver.todo');
        document.getElementById('label-processed').innerText = i18n.t('screensaver.done');
        document.getElementById('status-text').innerText = i18n.t('screensaver.active');
    });
}

let initialProcessedCount = -1;
let initialPendingCount = -1;
let lastProcessedCount = -1;
let lastPendingCount = -1;
let isOcrProcessing = false;
let visualQueue = 0; // Number of images that should still fly visually.
let isAnimating = false;
let appVersion = '';

function updateFooterStatus() {
    const statusEl = document.getElementById('status-text');
    if (!statusEl) return;
    const time = new Date().toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    statusEl.innerText = `${time} | Screen Recorder${appVersion ? ' V' + appVersion : ''}`;
}

// OCR status from the main process (primary display only).
if (!isBlackMode) {
    const ocrDetailsEl = document.getElementById('ocr-details');
    
    ipcRenderer.on('ocr-status', (event, data) => {
        try {
            if (data.status === 'processing') {
                if (data.appVersion) {
                    appVersion = data.appVersion;
                    updateFooterStatus();
                }
                isOcrProcessing = true;
                if (data.count > 0) {
                    visualQueue += data.currentBatch || 1;
                    startNextAnimation();
                    
                    // Show details.
                    if (ocrDetailsEl) {
                        ocrDetailsEl.style.display = 'block';
                        const engine = data.engine || 'OCR';
                        const processed = data.processed || 0;
                        const total = data.totalImages !== undefined ? data.totalImages : (data.count || 0);
                        const file = data.file;
                        const result = data.result;
                        
                        let resultText = '';
                        try {
                            if (result === 'success') resultText = ` (${i18n.t('screensaver.ocr_success')})`;
                            else if (result === 'failed') resultText = ` (${i18n.t('screensaver.ocr_failed')})`;
                            else if (result === 'empty') resultText = ` (${i18n.t('screensaver.ocr_empty')})`;
                        } catch (e) {
                            console.error('Error getting result text:', e);
                        }
                        
                        try {
                            if (file) {
                                ocrDetailsEl.innerText = i18n.t('screensaver.ocr_status_with_file', {
                                    engine: engine,
                                    processed: processed,
                                    total: total,
                                    file: file
                                }) + resultText;
                            } else {
                                ocrDetailsEl.innerText = i18n.t('screensaver.ocr_status', {
                                    engine: engine,
                                    processed: processed,
                                    total: total
                                }) + resultText;
                            }
                        } catch (e) {
                            console.error('Error setting ocrDetailsEl text:', e);
                            ocrDetailsEl.innerText = `${engine}: ${processed} / ${total}${resultText}`;
                        }
                    }
                }
            } else {
                isOcrProcessing = false;
                if (ocrDetailsEl) {
                    ocrDetailsEl.style.display = 'none';
                }
                // Update stats immediately because a batch finished.
                updateStats();
            }
        } catch (err) {
            console.error('Error in ocr-status handler:', err);
        }
    });
}

async function startNextAnimation() {
    if (isAnimating) return;
    if (visualQueue <= 0) return;
    
    isAnimating = true;
    visualQueue--;
    
    await flyDocument();
    
    isAnimating = false;
    
    // Short delay before the next one.
    setTimeout(startNextAnimation, 500);
}

// Detect mouse movement.
let lastMouseX = -1;
let lastMouseY = -1;
document.addEventListener('mousemove', (e) => {
    if (lastMouseX === -1) {
        lastMouseX = e.screenX;
        lastMouseY = e.screenY;
        return;
    }
    const deltaX = Math.abs(e.screenX - lastMouseX);
    const deltaY = Math.abs(e.screenY - lastMouseY);
    if (deltaX > 10 || deltaY > 10) {
        ipcRenderer.send('mouse-move');
    }
});
document.addEventListener('keydown', () => {
    ipcRenderer.send('mouse-move');
});

const statsPendingEl = document.getElementById('stats-pending');
const statsProcessedEl = document.getElementById('stats-processed');
const countPendingEl = document.getElementById('count-pending');
const countProcessedEl = document.getElementById('count-processed');
const stackPendingEl = document.getElementById('stack-pending');

const DOC_ICON_SVG = `
    <svg class="photo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <line x1="16" y1="13" x2="8" y2="13"></line>
        <line x1="16" y1="17" x2="8" y2="17"></line>
        <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
`;

const FOLDER_ICON_SVG = `
    <svg class="folder-icon" viewBox="0 0 220 180" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="inboxBody" x1="35" y1="56" x2="190" y2="170" gradientUnits="userSpaceOnUse">
                <stop stop-color="rgba(255,211,136,0.22)"/>
                <stop offset="1" stop-color="rgba(126,243,221,0.13)"/>
            </linearGradient>
            <linearGradient id="inboxEdge" x1="24" y1="42" x2="198" y2="150" gradientUnits="userSpaceOnUse">
                <stop stop-color="rgba(255,232,176,0.72)"/>
                <stop offset="1" stop-color="rgba(126,243,221,0.58)"/>
            </linearGradient>
        </defs>
        <path class="inbox-sheet sheet-a" d="M66 18H154L178 42V124H66V18Z"/>
        <path class="inbox-sheet sheet-b" d="M48 32H138L162 56V136H48V32Z"/>
        <path class="inbox-body" d="M24 70H82L96 88H196V154C196 162 190 168 182 168H38C30 168 24 162 24 154V70Z"/>
        <path class="inbox-lip" d="M24 70H82L96 88H196"/>
        <path class="inbox-slot" d="M58 124H162"/>
        <path class="inbox-slot short" d="M78 144H142"/>
        <path class="inbox-corner" d="M154 18V42H178"/>
    </svg>
`;

function createDocumentElement() {
    const el = document.createElement('div');
    el.className = 'photo';
    el.innerHTML = DOC_ICON_SVG;
    return el;
}

function updateStackVisuals(container, count, isPending) {
    if (!isPending) return;
    
    // Ensure only one folder icon exists (no stack anymore).
    if (container.children.length === 0 || !container.querySelector('.folder-icon')) {
        container.innerHTML = `<div class="folder-container">${FOLDER_ICON_SVG}</div>`;
    }
}

function flyDocument() {
    return new Promise((resolve) => {
        const leftRect = stackPendingEl.getBoundingClientRect();
        const containerRect = document.getElementById('container').getBoundingClientRect();
        
        const startX = leftRect.left + leftRect.width / 2;
        const startY = leftRect.top + leftRect.height / 2;
        
        // The target position for "processing" is centered on the right side.
        const processX = containerRect.width * 0.75;
        const processY = containerRect.height / 2;
        
        const doc = createDocumentElement();
        doc.style.position = 'fixed';
        doc.style.left = startX + 'px';
        doc.style.top = startY + 'px';
        doc.style.zIndex = '1000';
        doc.style.transform = `translate(-50%, -50%) rotate(${(Math.random()-0.5)*20}deg) scale(1)`;
        
        document.body.appendChild(doc);
        
        // 1. Fly to the center-right and enlarge.
        setTimeout(() => {
            doc.classList.add('processing');
            doc.style.left = processX + 'px';
            doc.style.top = processY + 'px';
            doc.style.transform = `translate(-50%, -50%) rotate(0deg) scale(3.5)`; // Slightly larger for more focus.
        }, 50);

        // 2. Wait while OCR is running, but at least 1.5s and at most 10s for the animation.
        const waitStartTime = Date.now();
        const checkOcr = setInterval(() => {
            const elapsed = Date.now() - waitStartTime;
            
            // When OCR is finished or the minimum timeout has been reached.
            if ((!isOcrProcessing && elapsed > 1500) || elapsed > 4000) {
                clearInterval(checkOcr);
                
                // 3. Disappear backward (at the same position).
                doc.classList.remove('processing');
                doc.classList.add('disappearing');
                
                // Keep the position, but shrink to 0 (as defined in CSS).
                
                setTimeout(() => {
                    doc.remove();
                    resolve();
                }, 1600);
            }
        }, 100);
    });
}

function formatPercent(value) {
    if (!Number.isFinite(value)) return '0%';

    const clamped = Math.max(0, Math.min(100, value));
    if (clamped > 0 && clamped < 1) return `${clamped.toFixed(2)}%`;
    if (clamped < 10 && !Number.isInteger(clamped)) return `${clamped.toFixed(1)}%`;
    return `${Math.round(clamped)}%`;
}

async function updateStats() {
    try {
        const stats = await ipcRenderer.invoke('get-ocr-stats');
        
        if (initialProcessedCount === -1) {
            initialProcessedCount = stats.processed;
            initialPendingCount = stats.pending;
        }
        
        const sessionProcessed = Math.max(0, stats.processed - initialProcessedCount);
        const sessionTotal = initialPendingCount > 0 ? initialPendingCount : stats.total;
        const processedPercent = sessionTotal > 0 ? (sessionProcessed / sessionTotal) * 100 : 0;
        const pendingPercent = sessionTotal > 0 ? (stats.pending / sessionTotal) * 100 : 0;
        
        const pendingPercentText = formatPercent(pendingPercent);
        const processedPercentText = formatPercent(processedPercent);

        statsPendingEl.innerText = pendingPercentText;
        statsProcessedEl.innerText = processedPercentText;
        
        countPendingEl.innerText = `${stats.pending.toLocaleString()} ${i18n.t('screensaver.documents')}`;
        countProcessedEl.innerText = `${sessionProcessed.toLocaleString()} ${i18n.t('screensaver.documents')}`;
        
        // Stack visualization (left: one folder, right: no stack).
        updateStackVisuals(stackPendingEl, stats.pending, true);
        
        // If OCR is not running but documents from a previous batch still need to fly,
        // or if we are idle and still have pending documents,
        // fill the queue slightly to show activity.
        if (!isOcrProcessing && visualQueue === 0 && stats.pending > 0) {
            visualQueue = Math.min(stats.pending, 3);
            startNextAnimation();
        }
        
        lastProcessedCount = stats.processed;
        lastPendingCount = stats.pending;
    } catch (e) {
        console.error('Failed to update stats:', e);
    }
}

// Initial call.
if (!isBlackMode) {
    updateFooterStatus();
    setInterval(updateFooterStatus, 1000);
    updateStats();
    // Check stats every 2 seconds.
    setInterval(updateStats, 2000);
}
