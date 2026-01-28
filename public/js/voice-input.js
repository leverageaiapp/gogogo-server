class VoiceInput {
    constructor() {
        this.voiceBtn = document.getElementById('voice-btn');
        this.input = document.getElementById('input');
        this.transcriptionDiv = document.getElementById('transcription');
        this.contextOverlay = document.getElementById('context-overlay');
        this.contextOverlayContent = document.getElementById('context-overlay-content');

        this.isRecording = false;
        this.interimTranscript = '';
        this.finalTranscript = '';
        this.collectedTranscript = ''; // Store all collected transcripts
        this.interimTimer = null; // Timer to auto-hide interim transcript after 3 seconds
        this.autoSubmitPending = false; // Flag to auto-submit after Claude processing

        // Claude API is now handled by the gateway service
        // No need for API keys in the client

        // Debug flag (will be updated from server)
        this.debugMode = false;
        this.checkDebugMode();

        this.init();
    }

    // Helper function for conditional debug logging
    debugLog(...args) {
        if (this.debugMode) {
            console.log(...args);
        }
    }

    // Check if debug mode is enabled on server
    async checkDebugMode() {
        try {
            const response = await fetch('api/terminal-context');
            if (response.ok) {
                const data = await response.json();
                this.debugMode = data.debugAsr || false;
                if (this.debugMode) {
                    console.log('[Voice Input] Debug mode enabled');
                }
            }
        } catch (e) {
            // Ignore errors
        }
    }

    init() {
        this.voiceBtn.addEventListener('click', () => this.toggleRecording());

        // Check for browser support
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('Voice input not supported in this browser');
            this.voiceBtn.style.display = 'none';
            return;
        }

        // Check Terminal ASR configuration (uses terminal WebSocket -> local server -> gateway)
        if (!window.terminalASR) {
            console.error('Terminal ASR not loaded');
            this.voiceBtn.style.display = 'none';
            return;
        }
    }

    async toggleRecording() {
        if (this.isRecording) {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async startRecording() {
        try {
            // Terminal ASR uses local server which connects to gateway
            // API keys are configured on the gateway server

            // Update context from terminal output
            const terminalLines = this.getTerminalContext();
            const context = window.terminalASR.updateContext(terminalLines);

            // Show loading indicator immediately
            this.showLoadingIndicator();

            // Clear previous transcripts
            this.interimTranscript = '';
            this.finalTranscript = '';
            this.collectedTranscript = ''; // Reset collected transcript
            this.updateTranscriptionDisplay();

            // Start real-time recording with Terminal ASR
            await window.terminalASR.startRecording(
                // onPartialResult
                (text) => {
                    this.interimTranscript = text;
                    this.updateTranscriptionDisplay();
                },
                // onFinalResult
                (text) => {
                    // Always collect the transcript first (before any checks)
                    // This ensures we don't lose the text when "go go go" is detected
                    if (this.finalTranscript) {
                        this.finalTranscript += ' ' + text;
                    } else {
                        this.finalTranscript = text;
                    }
                    if (this.collectedTranscript) {
                        this.collectedTranscript += ' ' + text;
                    } else {
                        this.collectedTranscript = text;
                    }

                    // Clear interim transcript - final result replaces it
                    // This matches iOS behavior: interimTranscription = ""
                    this.interimTranscript = '';

                    this.updateTranscriptionDisplay();

                    // Check for "go go go" command (case insensitive, with variations)
                    const goPattern = /go\s*go\s*go|gogogo/i;
                    if (goPattern.test(text)) {
                        console.log('[Voice Input] "go go go" command detected!');
                        // Set flag to auto-submit after Claude processing
                        this.autoSubmitPending = true;
                        // Stop recording immediately
                        this.stopRecording();
                        return;
                    }

                    // DON'T add to input immediately - wait for stop
                    // this.addToInput(text);  // REMOVED
                },
                // onError - called for errors during recording (not startup errors)
                (error) => {
                    console.error('Voice error:', error);
                    this.showError(error.message);
                    this.stopRecording();
                },
                // onReady - called when ASR session is ready to receive audio
                () => {
                    // Update loading indicator to show recording state
                    this.transcriptionDiv.innerHTML = `<span style="color: #ef4444">● Recording...</span>`;
                    this.transcriptionDiv.style.display = 'block';
                    this.transcriptionDiv.classList.add('visible');
                    // Show terminal context overlay
                    this.showContextOverlay(context);
                }
            );

            // Update UI - only reached if startRecording succeeded
            this.isRecording = true;
            this.voiceBtn.classList.add('active');
            this.voiceBtn.title = 'Click to stop recording';

        } catch (error) {
            // Startup error - hide loading indicator and show error
            console.error('Failed to start recording:', error);
            this.hideLoadingIndicator();
            this.showError(error.message);
        }
    }

    async stopRecording() {
        if (!this.isRecording) return;

        console.log('[Voice Input] Stopping recording...');

        // Stop recording with Terminal ASR
        await window.terminalASR.stopRecording();

        // Update UI
        this.isRecording = false;
        this.voiceBtn.classList.remove('active');
        this.voiceBtn.title = 'Voice input (Click to start/stop)';

        // Hide context overlay
        this.hideContextOverlay();

        // Clear any pending interim timer
        if (this.interimTimer) {
            clearTimeout(this.interimTimer);
            this.interimTimer = null;
        }

        // Debug: Check collected transcript
        console.log('[Voice Input] Collected transcript:', this.collectedTranscript);
        console.log('[Voice Input] Final transcript:', this.finalTranscript);

        // Get the raw transcription
        const rawText = this.collectedTranscript || this.finalTranscript;

        if (rawText && rawText.trim()) {
            // First, INSERT (not replace) the raw text into input
            const currentValue = this.input.value;
            if (currentValue) {
                // Insert at cursor position or at end
                const cursorPos = this.input.selectionStart || currentValue.length;
                this.input.value = currentValue.slice(0, cursorPos) + rawText.trim() + ' ' + currentValue.slice(cursorPos);
            } else {
                this.input.value = rawText.trim();
            }

            console.log('[Voice Input] Inserted raw text:', rawText.trim());

            // Show loading indicator for Claude correction
            this.transcriptionDiv.innerHTML = `<div class="interim-text">AI optimizing...</div>`;
            this.transcriptionDiv.style.display = 'block';

            // Request Claude correction via terminal WebSocket -> gateway
            window.terminalASR.requestCorrection(rawText.trim(), (original, corrected) => {
                console.log('[Voice Input] Claude correction received:', corrected);

                // Replace the inserted raw text with corrected text
                if (this.input.value.includes(original)) {
                    this.input.value = this.input.value.replace(original, corrected);
                    console.log('[Voice Input] Replaced with corrected text');
                }

                // Hide loading indicator immediately
                this.transcriptionDiv.classList.remove('visible');
                this.transcriptionDiv.innerHTML = '';
                this.transcriptionDiv.style.display = 'none';

                // Check for auto-submit (go go go command)
                if (this.autoSubmitPending) {
                    console.log('[Voice Input] Auto-submit triggered by go go go command');
                    this.autoSubmitPending = false;

                    // Remove "go go go" variants from the input text
                    const goPattern = /\s*(go\s*go\s*go|gogogo)[。.!！]?\s*/gi;
                    this.input.value = this.input.value.replace(goPattern, '').trim();

                    // Trigger enter key press to submit
                    if (this.input.value) {
                        const enterEvent = new KeyboardEvent('keydown', {
                            key: 'Enter',
                            code: 'Enter',
                            keyCode: 13,
                            which: 13,
                            bubbles: true
                        });
                        this.input.dispatchEvent(enterEvent);
                    }
                }
            });
        }

        // Clear transcription after Claude correction or timeout
        // Don't clear immediately as we need them for correction callback
        setTimeout(() => {
            this.interimTranscript = '';
            this.finalTranscript = '';
            this.collectedTranscript = '';
            // Only update display if not still waiting for correction
            if (!this.transcriptionDiv.innerHTML.includes('AI optimizing')) {
                this.updateTranscriptionDisplay();
            }
        }, 5000);
    }

    // Claude processing is now handled by the gateway service
    // The processWithClaude method is no longer needed
    async processWithClaude_DEPRECATED(transcript) {
        this.debugLog('[Claude] Starting to process transcript:', transcript);

        try {
            // Get terminal context
            const terminalContext = window.terminalASR ? window.terminalASR.terminalContext : '';
            this.debugLog('[Claude] Terminal context length:', terminalContext.length);

            // Store existing input content to append to later
            this.existingInputContent = this.input.value;
            // Clear input only for the streaming content (will be restored)
            this.input.value = '';

            // Send to server via WebSocket to process with Claude
            if (window.terminalWs && window.terminalWs.readyState === WebSocket.OPEN) {
                this.debugLog('[Claude] Sending to server via WebSocket');
                console.log('[Claude] Sending to server via WebSocket');

                // Send Claude processing request
                window.terminalWs.send(JSON.stringify({
                    type: 'claude_process',
                    transcript: transcript,
                    context: terminalContext,
                    api_key: this.claudeApiKey,
                    model: this.claudeModel
                }));

                console.log('[Claude] Request sent to server');
                // The server will send back claude_response messages with the streamed text
                // These will be handled in the existing WebSocket message handler
            } else {
                console.error('[Claude] WebSocket not connected:', window.terminalWs ? 'exists but not open' : 'does not exist');
                // Fallback: append the original transcript to existing content
                const existingContent = this.existingInputContent || '';
                const needSpace = existingContent && !existingContent.endsWith(' ');
                this.input.value = existingContent + (needSpace ? ' ' : '') + transcript;
                this.input.style.height = 'auto';
                this.input.style.height = this.input.scrollHeight + 'px';
            }
        } catch (error) {
            console.error('[Claude] Error:', error);
            // Fallback: append the original transcript to existing content
            const existingContent = this.existingInputContent || this.input.value || '';
            const needSpace = existingContent && !existingContent.endsWith(' ');
            this.input.value = existingContent + (needSpace ? ' ' : '') + transcript;
            this.input.style.height = 'auto';
            this.input.style.height = this.input.scrollHeight + 'px';
        }
    }

    getTerminalContext() {
        // Get terminal lines from xterm.js
        if (window.term) {
            const buffer = window.term.buffer.active;
            const lines = [];
            for (let i = Math.max(0, buffer.length - 50); i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (line) {
                    lines.push(line.translateToString(true));
                }
            }
            return lines;
        }
        return [];
    }

    updateTranscriptionDisplay() {
        // Use transcriptionDiv (blue floating dialog) for transcription display
        if (!this.transcriptionDiv) return;

        // Use collectedTranscript which accumulates ALL final results
        // interimTranscript contains only the current partial (not yet confirmed)
        const hasText = this.interimTranscript || this.collectedTranscript;

        if (hasText) {
            this.transcriptionDiv.style.display = 'block';
            this.transcriptionDiv.classList.add('visible');
            // Display: [all previous final results] + [current interim]
            // This matches iOS behavior: transcription + interimTranscription
            this.transcriptionDiv.innerHTML = `
                ${this.collectedTranscript ? `<strong>${this.collectedTranscript}</strong>` : ''}
                ${this.interimTranscript ? `<span style="opacity: 0.7"> ${this.interimTranscript}</span>` : ''}
            `;

            // Don't auto-hide during recording - let stop handle cleanup
        } else if (!this.isRecording) {
            // Only hide if not recording
            this.transcriptionDiv.classList.remove('visible');
            this.transcriptionDiv.innerHTML = '';
            this.transcriptionDiv.style.display = 'none';
        }
    }

    addToInput(text) {
        if (this.input && text) {
            // Get current input value
            const currentValue = this.input.value;

            // Add space if needed
            if (currentValue && !currentValue.endsWith(' ')) {
                this.input.value = currentValue + ' ' + text;
            } else {
                this.input.value = currentValue + text;
            }

            // Trigger input event for any listeners
            this.input.dispatchEvent(new Event('input', { bubbles: true }));

            // Focus input
            this.input.focus();
        }
    }

    showError(message) {
        if (this.transcriptionDiv) {
            this.transcriptionDiv.classList.add('visible');
            this.transcriptionDiv.innerHTML = `<span style="color: #ef4444">❌ ${message}</span>`;

            setTimeout(() => {
                this.transcriptionDiv.classList.remove('visible');
            }, 3000);
        }
    }

    showLoadingIndicator() {
        // Use transcriptionDiv (blue floating dialog) for loading indicator
        if (this.transcriptionDiv) {
            this.transcriptionDiv.classList.add('visible');
            this.transcriptionDiv.innerHTML = `<span style="color: #60a5fa">🔄 Please wait, initializing voice input...</span>`;
        }
    }

    hideLoadingIndicator() {
        // Hide the loading indicator
        if (this.transcriptionDiv) {
            this.transcriptionDiv.classList.remove('visible');
            this.transcriptionDiv.innerHTML = '';
        }
    }

    showContextOverlay(context) {
        if (this.contextOverlay && this.contextOverlayContent) {
            this.contextOverlayContent.textContent = context || 'No context available yet...';
            this.contextOverlay.classList.add('visible');
        }
    }

    hideContextOverlay() {
        if (this.contextOverlay) {
            this.contextOverlay.classList.remove('visible');
        }
    }
}

// Initialize voice input when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.voiceInput = new VoiceInput();
});