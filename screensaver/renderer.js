const { ipcRenderer } = require('electron');
const i18n = require('../shared/i18n');
const { getLanguage } = require('../shared/config');

// Sprache initialisieren
const lang = getLanguage();
i18n.init(lang);

// Parameter aus URL prüfen
const urlParams = new URLSearchParams(window.location.search);
const isBlackMode = urlParams.get('black') === '1';

if (isBlackMode) {
    // Alles verstecken für schwarzen Modus
    document.addEventListener('DOMContentLoaded', () => {
        const container = document.getElementById('container');
        const overlay = document.getElementById('overlay');
        if (container) container.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        document.body.style.backgroundColor = 'black';
    });
} else {
    // Labels übersetzen
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('label-pending').innerText = i18n.t('screensaver.todo');
        document.getElementById('label-processed').innerText = i18n.t('screensaver.done');
        document.getElementById('status-text').innerText = i18n.t('screensaver.active');
    });
}

let initialProcessedCount = -1;
let lastProcessedCount = -1;
let lastPendingCount = -1;
let isOcrProcessing = false;
let visualQueue = 0; // Anzahl der Bilder, die noch visuell fliegen sollen
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

// OCR Status vom Main Prozess (nur auf Hauptbildschirm)
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
                    
                    // Details anzeigen
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
                // Sofort Stats updaten, da ein Batch fertig ist
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
    
    // Kleiner Delay vor dem nächsten
    setTimeout(startNextAnimation, 500);
}

// Mausbewegung erkennen
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
    
    // Sicherstellen, dass nur ein Ordner-Icon existiert (kein Stapel mehr)
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
        
        // Die Zielposition für die "Verarbeitung" ist auf der rechten Seite mittig
        const processX = containerRect.width * 0.75;
        const processY = containerRect.height / 2;
        
        const doc = createDocumentElement();
        doc.style.position = 'fixed';
        doc.style.left = startX + 'px';
        doc.style.top = startY + 'px';
        doc.style.zIndex = '1000';
        doc.style.transform = `translate(-50%, -50%) rotate(${(Math.random()-0.5)*20}deg) scale(1)`;
        
        document.body.appendChild(doc);
        
        // 1. Flug zur Mitte-Rechts + Vergrößern
        setTimeout(() => {
            doc.classList.add('processing');
            doc.style.left = processX + 'px';
            doc.style.top = processY + 'px';
            doc.style.transform = `translate(-50%, -50%) rotate(0deg) scale(3.5)`; // Noch etwas größer für mehr Fokus
        }, 50);

        // 2. Warten (solange OCR läuft, aber mindestens 1.5s und maximal 10s für die Animation)
        const waitStartTime = Date.now();
        const checkOcr = setInterval(() => {
            const elapsed = Date.now() - waitStartTime;
            
            // Wenn OCR fertig ist ODER wir ein Mindesttimeout erreicht haben
            if ((!isOcrProcessing && elapsed > 1500) || elapsed > 4000) {
                clearInterval(checkOcr);
                
                // 3. Nach hinten verschwinden (an der gleichen Position)
                doc.classList.remove('processing');
                doc.classList.add('disappearing');
                
                // Wir behalten die Position bei, verkleinern aber auf 0 (wie in CSS definiert)
                
                setTimeout(() => {
                    doc.remove();
                    resolve();
                }, 1600);
            }
        }, 100);
    });
}

async function updateStats() {
    try {
        const stats = await ipcRenderer.invoke('get-ocr-stats');
        
        if (initialProcessedCount === -1) {
            initialProcessedCount = stats.processed;
        }
        
        const sessionProcessed = Math.max(0, stats.processed - initialProcessedCount);
        
        // Prozentanzeige mit einer Nachkommastelle, wenn unter 10%
        let pendingPercentText = `${stats.pendingPercent}%`;
        let processedPercentText = `${stats.processedPercent}%`;
        
        if (stats.total > 0 && stats.processedPercent < 10) {
            const preciseProcessed = (stats.processed / stats.total) * 100;
            const precisePending = (stats.pending / stats.total) * 100;
            if (preciseProcessed > 0 && preciseProcessed < 1) {
                processedPercentText = `${preciseProcessed.toFixed(2)}%`;
            } else if (preciseProcessed < 10) {
                processedPercentText = `${preciseProcessed.toFixed(1)}%`;
            }
            
            if (precisePending > 90 && precisePending < 100) {
                pendingPercentText = `${precisePending.toFixed(1)}%`;
            }
        }

        statsPendingEl.innerText = pendingPercentText;
        statsProcessedEl.innerText = processedPercentText;
        
        countPendingEl.innerText = `${stats.pending.toLocaleString()} ${i18n.t('screensaver.documents')}`;
        countProcessedEl.innerText = `${sessionProcessed.toLocaleString()} ${i18n.t('screensaver.documents')}`;
        
        // Stapel-Visualisierung (Links: ein Ordner, Rechts: kein Stapel)
        updateStackVisuals(stackPendingEl, stats.pending, true);
        
        // Wenn OCR nicht läuft, aber wir noch Dokumente zum Fliegen haben (aus einem vorherigen Batch)
        // oder wenn wir einfach im Leerlauf sind und Pending Dokumente haben, 
        // füllen wir die Queue ein bisschen auf, um Aktivität zu zeigen.
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

// Initialer Aufruf
if (!isBlackMode) {
    updateFooterStatus();
    setInterval(updateFooterStatus, 1000);
    updateStats();
    // Alle 2 Sekunden Stats prüfen
    setInterval(updateStats, 2000);
}
