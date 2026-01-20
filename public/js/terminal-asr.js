/**
 * Terminal ASR - Uses terminal WebSocket for ASR
 * Communicates with backend which proxies to voice.futuretech.social gateway
 * NO API KEY REQUIRED - the server handles the gateway connection
 */
class TerminalASR {
    constructor() {
        this.language = 'zh';
        this.isRecording = false;
        this.audioContext = null;
        this.processor = null;
        this.source = null;
        this.stream = null;
        this.terminalContext = '';
        this.maxContextLength = 2000;

        // Callbacks
        this.onPartialResult = null;
        this.onFinalResult = null;
        this.onError = null;
        this.onReady = null; // Called when ASR session is ready to receive audio
        this.onCorrectionResult = null; // Called when Claude correction is received

        // ASR session state
        this.asrSessionActive = false;
        this.sessionReady = false; // True when ASR backend is ready to receive audio
        this.audioBuffer = [];
        this.pendingAudioBuffer = []; // Buffer audio before ASR is ready

        // Setup message handler
        window.handleASRResponse = (data) => {
            this.handleASRResponse(data);
        };
    }

    /**
     * Check if configured (always true - no API key needed)
     */
    isConfigured() {
        return true;
    }

    /**
     * Update context from terminal output
     */
    updateContext(terminalLines) {
        const recentLines = terminalLines.slice(-50).join('\n');
        if (recentLines.length > this.maxContextLength) {
            this.terminalContext = recentLines.slice(-this.maxContextLength);
        } else {
            this.terminalContext = recentLines;
        }
        console.log('[Terminal ASR] Context updated, length:', this.terminalContext.length);
        return this.terminalContext;
    }

    /**
     * Set maximum context length
     */
    setMaxContextLength(length) {
        this.maxContextLength = Math.min(Math.max(100, length), 10000);
    }

    /**
     * Start real-time recording and streaming
     */
    async startRecording(onPartialResult, onFinalResult, onError, onReady) {
        // Check if terminal WebSocket is connected
        if (!window.terminalWs || window.terminalWs.readyState !== WebSocket.OPEN) {
            const err = new Error('Terminal WebSocket not connected');
            onError(err);
            throw err;
        }

        this.onPartialResult = onPartialResult;
        this.onFinalResult = onFinalResult;
        this.onError = onError;
        this.onReady = onReady;

        try {
            // Get microphone access
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    sampleSize: 16,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Create audio context
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });

            this.source = this.audioContext.createMediaStreamSource(this.stream);

            // Start ASR session via terminal WebSocket
            // Server will connect to voice.futuretech.social gateway
            const startMessage = {
                type: 'asr_start',
                language: this.language,
                context: this.terminalContext
            };

            window.terminalWs.send(JSON.stringify(startMessage));
            console.log('[Terminal ASR] Sent ASR start message');

            this.isRecording = true;
            this.asrSessionActive = true;
            this.sessionReady = false; // Will be set to true when asr_ready is received
            this.audioBuffer = [];
            this.pendingAudioBuffer = []; // Clear pending buffer

            // Start audio processing immediately (audio will be buffered until ASR is ready)
            this.startAudioProcessing();

        } catch (error) {
            console.error('[Terminal ASR] Failed to start recording:', error);
            onError(error);
        }
    }

    /**
     * Start processing and sending audio data
     */
    startAudioProcessing() {
        // Create ScriptProcessor for audio processing
        const bufferSize = 4096;
        this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

        this.processor.onaudioprocess = (e) => {
            if (!this.isRecording || !window.terminalWs || window.terminalWs.readyState !== WebSocket.OPEN) {
                return;
            }

            const inputData = e.inputBuffer.getChannelData(0);

            // Convert float32 to int16 PCM
            const pcmData = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Add to buffer (will be sent or cached based on sessionReady state)
            this.audioBuffer.push(pcmData);
        };

        // Send audio data periodically
        this.sendInterval = setInterval(() => {
            if (this.audioBuffer.length > 0 && this.asrSessionActive) {
                // Combine all buffered audio
                const totalLength = this.audioBuffer.reduce((acc, arr) => acc + arr.length, 0);
                const combinedBuffer = new Int16Array(totalLength);
                let offset = 0;
                for (const buffer of this.audioBuffer) {
                    combinedBuffer.set(buffer, offset);
                    offset += buffer.length;
                }

                // Convert to base64
                const base64Audio = this.arrayBufferToBase64(combinedBuffer.buffer);

                if (this.sessionReady) {
                    // ASR is ready - send audio immediately
                    const audioMessage = {
                        type: 'asr_audio',
                        audio: base64Audio
                    };
                    window.terminalWs.send(JSON.stringify(audioMessage));
                } else {
                    // ASR not ready yet - cache audio for later
                    this.pendingAudioBuffer.push(base64Audio);
                    console.log('[Terminal ASR] Buffering audio (session not ready), buffer size:', this.pendingAudioBuffer.length);
                }

                // Clear buffer
                this.audioBuffer = [];
            }
        }, 100);

        // Connect audio nodes
        this.source.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
    }

    /**
     * Send all pending buffered audio when ASR becomes ready
     */
    sendPendingAudio() {
        if (this.pendingAudioBuffer.length > 0) {
            console.log('[Terminal ASR] Sending', this.pendingAudioBuffer.length, 'buffered audio chunks');

            // Send all buffered audio
            for (const base64Audio of this.pendingAudioBuffer) {
                const audioMessage = {
                    type: 'asr_audio',
                    audio: base64Audio
                };
                window.terminalWs.send(JSON.stringify(audioMessage));
            }

            // Clear pending buffer
            this.pendingAudioBuffer = [];
        }
    }

    /**
     * Handle ASR response from server
     */
    handleASRResponse(data) {
        console.log('[Terminal ASR] Received ASR response:', data);

        if (data.error) {
            // Handle error object or string
            const errorMessage = typeof data.error === 'string' ?
                data.error :
                (data.error.message || JSON.stringify(data.error));

            // Don't report errors for stopping recording
            if (errorMessage.includes('no invalid audio stream') ||
                errorMessage.includes('committing input audio buffer')) {
                console.log('[Terminal ASR] Ignoring stop recording error');
                return;
            }

            console.error('[Terminal ASR] ASR error:', errorMessage);
            if (this.onError) {
                this.onError(new Error(errorMessage));
            }
            return;
        }

        // Handle different response types
        if (data.type === 'asr_ready') {
            console.log('[Terminal ASR] ASR ready to receive audio');
            this.sessionReady = true;
            // Send any audio that was buffered while waiting for ASR to be ready
            this.sendPendingAudio();
            if (this.onReady) {
                this.onReady();
            }
        } else if (data.type === 'session.created') {
            console.log('[Terminal ASR] Session created');
        } else if (data.type === 'session.updated') {
            console.log('[Terminal ASR] Session updated');
        } else if (data.type === 'partial') {
            // Partial transcription from gateway
            const text = data.text || data.transcript;
            if (text) {
                console.log('[Terminal ASR] Partial result:', text);
                if (this.onPartialResult) {
                    this.onPartialResult(text);
                }
            }
        } else if (data.type === 'conversation.item.input_audio_transcription.completed') {
            // Final transcription - from both DashScope format and gateway
            const text = data.transcript || data.text;
            if (text) {
                console.log('[Terminal ASR] Transcription completed:', text);
                if (this.onFinalResult) {
                    this.onFinalResult(text);
                }
            }
        } else if (data.type === 'conversation.item.input_audio_transcription.in_progress') {
            // Partial transcription
            const text = data.transcript;
            if (text) {
                console.log('[Terminal ASR] Transcription in progress:', text);
                if (this.onPartialResult) {
                    this.onPartialResult(text);
                }
            }
        } else if (data.type === 'correction_result') {
            // Claude correction result from gateway
            console.log('[Terminal ASR] Claude correction:', data.original, '->', data.corrected);
            // Store the correction for use
            this.lastCorrection = {
                original: data.original,
                corrected: data.corrected
            };
            // Notify via callback if set
            if (this.onCorrectionResult) {
                this.onCorrectionResult(data.original, data.corrected);
            }
        } else if (data.transcript || data.text) {
            // This is a transcription result (fallback handling)
            const text = data.transcript || data.text;

            if (data.is_final || data.sentence_end) {
                // Final result
                console.log('[Terminal ASR] Final:', text);
                if (this.onFinalResult) {
                    this.onFinalResult(text);
                }
            } else {
                // Partial result
                console.log('[Terminal ASR] Partial:', text);
                if (this.onPartialResult) {
                    this.onPartialResult(text);
                }
            }
        }
    }

    /**
     * Stop recording
     */
    async stopRecording() {
        this.isRecording = false;
        this.asrSessionActive = false;
        this.sessionReady = false;
        this.pendingAudioBuffer = []; // Clear any pending audio

        // Clear intervals
        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = null;
        }

        // Send any remaining audio
        if (this.audioBuffer.length > 0 && window.terminalWs && window.terminalWs.readyState === WebSocket.OPEN) {
            // Combine all buffered audio
            const totalLength = this.audioBuffer.reduce((acc, arr) => acc + arr.length, 0);
            const combinedBuffer = new Int16Array(totalLength);
            let offset = 0;
            for (const buffer of this.audioBuffer) {
                combinedBuffer.set(buffer, offset);
                offset += buffer.length;
            }

            // Convert to base64
            const base64Audio = this.arrayBufferToBase64(combinedBuffer.buffer);

            // Send final audio data
            const audioMessage = {
                type: 'asr_audio',
                audio: base64Audio
            };
            window.terminalWs.send(JSON.stringify(audioMessage));
            this.audioBuffer = [];
        }

        // Stop ASR session
        if (window.terminalWs && window.terminalWs.readyState === WebSocket.OPEN) {
            const stopMessage = {
                type: 'asr_stop'
            };
            window.terminalWs.send(JSON.stringify(stopMessage));
            console.log('[Terminal ASR] Sent ASR stop message');
        }

        // Clean up audio resources
        if (this.processor) {
            this.processor.disconnect();
            this.processor = null;
        }

        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        console.log('[Terminal ASR] Recording stopped');
    }

    /**
     * Convert ArrayBuffer to Base64
     */
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Request Claude correction for transcribed text
     * Uses terminal WebSocket to send request to server, which forwards to gateway
     */
    requestCorrection(text, callback) {
        if (!text || !text.trim()) {
            console.log('[Terminal ASR] No text to correct');
            if (callback) {
                callback(text, text);
            }
            return;
        }

        // Check if terminal WebSocket is connected
        if (!window.terminalWs || window.terminalWs.readyState !== WebSocket.OPEN) {
            console.error('[Terminal ASR] WebSocket not connected for correction');
            if (callback) {
                callback(text, text);
            }
            return;
        }

        // Set callback for correction result
        this.onCorrectionResult = (original, corrected) => {
            if (callback) {
                callback(original, corrected);
            }
        };

        // Send claude_process request via terminal WebSocket
        const correctionRequest = {
            type: 'claude_process',
            transcript: text,
            context: this.terminalContext
        };

        window.terminalWs.send(JSON.stringify(correctionRequest));
        console.log('[Terminal ASR] Sent correction request:', text);
    }
}

// Create global instance
window.terminalASR = new TerminalASR();