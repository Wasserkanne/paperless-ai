const fs = require('fs');
const util = require('util');
const path = require('path');

const sinks = [];
let originalConsole = null;

const consoleMethodTypes = {
    log: 'info',
    error: 'error',
    warn: 'warn',
    info: 'info',
    debug: 'debug'
};

function installConsoleOverride() {
    if (originalConsole) {
        return;
    }

    originalConsole = {
        log: console.log,
        error: console.error,
        warn: console.warn,
        info: console.info,
        debug: console.debug
    };

    for (const [method, type] of Object.entries(consoleMethodTypes)) {
        console[method] = (...args) => {
            originalConsole[method](...args);
            for (const sink of sinks) {
                sink.write(sink.formatLogMessage(type, args));
            }
        };
    }

    process.on('exit', () => {
        for (const sink of sinks) {
            sink.flushSync();
        }
    });
}

class Logger {
    constructor(options = {}) {
        this.logFile = options.logFile || 'application.log';
        this.logDir = options.logDir || 'logs';
        this.timestamp = options.timestamp !== false;
        this.format = options.format || 'txt';
        this.maxFileSize = options.maxFileSize || 1024 * 1024 * 10; // Standard: 10MB

        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        this.logPath = path.join(this.logDir, this.logFile);

        this.queue = [];
        this.flushing = false;
        this.fd = null;
        this.size = 0;

        // Initialisiere Log-Datei
        this.initLogFile();
        this.openFile();

        sinks.push(this);
        installConsoleOverride();
    }

    initLogFile() {
        // Prüfe ob die Datei die maximale Größe überschreitet
        if (this.checkFileSize()) {
            // Lösche die alte Datei
            try {
                fs.unlinkSync(this.logPath);
            } catch {
                // Ignoriere Fehler wenn Datei nicht existiert
            }
        }

        // Initialisiere HTML-Datei wenn nötig
        if (this.format === 'html') {
            this.initHtmlFile();
        }
    }

    checkFileSize() {
        if (fs.existsSync(this.logPath)) {
            const stats = fs.statSync(this.logPath);
            return stats.size >= this.maxFileSize;
        }
        return false;
    }

    openFile() {
        this.fd = fs.openSync(this.logPath, 'a');
        this.size = fs.fstatSync(this.fd).size;
    }

    initHtmlFile() {
        const htmlHeader = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Application Logs</title>
    <style>
        body {
            background-color: #1e1e1e;
            color: #ffffff;
            font-family: 'Consolas', 'Monaco', monospace;
            padding: 20px;
            margin: 0;
        }
        .log-container {
            background-color: #2d2d2d;
            border-radius: 5px;
            padding: 10px;
            max-width: 100%;
            overflow-x: auto;
        }
        .log-entry {
            padding: 3px 5px;
            margin: 2px 0;
            border-radius: 3px;
            white-space: pre-wrap;
        }
        .timestamp {
            color: #888888;
        }
        .type {
            font-weight: bold;
            margin: 0 5px;
        }
        .type-info { color: #4CAF50; }
        .type-error { color: #f44336; }
        .type-warn { color: #ff9800; }
        .type-debug { color: #2196F3; }
        .message { margin-left: 5px; }
        .auto-scroll {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #333;
            border: none;
            color: white;
            padding: 10px;
            border-radius: 5px;
            cursor: pointer;
        }
        .auto-scroll:hover {
            background: #444;
        }
    </style>
    <script>
        let autoScroll = true;
        function toggleAutoScroll() {
            autoScroll = !autoScroll;
            document.getElementById('autoScrollBtn').textContent = 
                autoScroll ? 'Auto-Scroll: ON' : 'Auto-Scroll: OFF';
        }
        function scrollToBottom() {
            if (autoScroll) {
                window.scrollTo(0, document.body.scrollHeight);
            }
        }
        const observer = new MutationObserver(scrollToBottom);
        window.onload = () => {
            observer.observe(document.querySelector('.log-container'), 
                { childList: true });
            scrollToBottom();
        };
    </script>
</head>
<body>
    <div class="log-container">
`;

        if (!fs.existsSync(this.logPath) || fs.statSync(this.logPath).size === 0) {
            fs.writeFileSync(this.logPath, htmlHeader);
        }
    }

    getTimestamp() {
        return new Date().toISOString();
    }

    formatLogMessage(type, args) {
        const msg = util.format(...args);
        if (this.format === 'html') {
            const timestamp = this.timestamp ? 
                `<span class="timestamp">[${this.getTimestamp()}]</span>` : '';
            return `    <div class="log-entry">
        ${timestamp}
        <span class="type type-${type}">[${type.toUpperCase()}]</span>
        <span class="message">${this.escapeHtml(msg)}</span>
    </div>\n`;
        } else {
            return this.timestamp ? 
                `[${this.getTimestamp()}] [${type.toUpperCase()}] ${msg}\n` :
                `[${type.toUpperCase()}] ${msg}\n`;
        }
    }

    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;")
            .replace(/\n/g, "<br>")
            .replace(/\s/g, "&nbsp;");
    }

    write(message) {
        this.queue.push(message);
        this.scheduleFlush();
    }

    scheduleFlush() {
        if (!this.flushing && this.fd !== null) {
            this.flushing = true;
            setImmediate(() => this.flush());
        }
    }

    drainQueue() {
        // Sammelt Nachrichten bis zum Dateigrößen-Limit
        if (this.size >= this.maxFileSize) {
            this.rotate();
        }
        let chunk = '';
        while (this.queue.length && this.size < this.maxFileSize) {
            const msg = this.queue.shift();
            chunk += msg;
            this.size += Buffer.byteLength(msg);
        }
        return chunk;
    }

    flush() {
        const chunk = this.drainQueue();
        if (!chunk) {
            this.flushing = false;
            return;
        }
        fs.write(this.fd, chunk, (err) => {
            if (err) {
                process.stderr.write(`Logger write failed: ${err.message}\n`);
            }
            this.flushing = false;
            if (this.queue.length) {
                this.scheduleFlush();
            }
        });
    }

    rotate() {
        fs.closeSync(this.fd);
        try {
            fs.unlinkSync(this.logPath);
        } catch {
            // Ignoriere Fehler wenn Datei nicht existiert
        }

        // Bei HTML-Format müssen wir den Header neu schreiben
        if (this.format === 'html') {
            this.initHtmlFile();
        }
        this.openFile();
    }

    flushSync() {
        while (this.queue.length) {
            const chunk = this.drainQueue();
            if (!chunk) {
                break;
            }
            fs.writeSync(this.fd, chunk);
        }
        this.flushing = false;
    }

    closeHtmlFile() {
        if (this.format === 'html') {
            const htmlFooter = `    </div>
    <button class="auto-scroll" id="autoScrollBtn" onclick="toggleAutoScroll()">
        Auto-Scroll: ON
    </button>
</body>
</html>`;
            this.write(htmlFooter);
            this.flushSync();
        }
    }

    restore() {
        const index = sinks.indexOf(this);
        if (index !== -1) {
            sinks.splice(index, 1);
        }
        if (this.format === 'html') {
            this.closeHtmlFile();
        }
        this.flushSync();
        if (this.fd !== null) {
            fs.closeSync(this.fd);
            this.fd = null;
        }
        if (sinks.length === 0 && originalConsole) {
            Object.assign(console, originalConsole);
            originalConsole = null;
        }
    }
}

module.exports = Logger;
