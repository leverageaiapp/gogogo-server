import { EventEmitter } from 'events';
import axios from 'axios';
import FormData from 'form-data';

interface ModelScopeConfig {
    apiKey?: string;
    apiUrl?: string;
    model?: string;
    language?: string;
    maxContextLength?: number;
}

interface TranscriptionResult {
    text: string;
    isFinal: boolean;
    timestamp: number;
}

export class VoiceRecognitionModelScope extends EventEmitter {
    private apiKey: string;
    private apiUrl: string;
    private model: string;
    private language: string;
    private maxContextLength: number;
    private audioBuffer: Buffer[] = [];
    private isRecording: boolean = false;
    private streamingSession: any = null;
    private contextText: string = '';

    constructor(config: ModelScopeConfig = {}) {
        super();
        this.apiKey = config.apiKey || process.env.MODELSCOPE_API_KEY || '';
        this.apiUrl = config.apiUrl || 'https://api-inference.modelscope.cn/v1/';
        this.model = config.model || 'qwen3-asr-flash';
        this.language = config.language || 'zh';
        this.maxContextLength = config.maxContextLength || 2000;

        if (!this.apiKey) {
            console.warn('[ModelScope ASR] API key not configured. Set MODELSCOPE_API_KEY environment variable.');
        }
    }

    /**
     * Update the context for better recognition accuracy
     */
    public updateContext(terminalOutput: string[]): void {
        // Extract the most recent terminal output as context
        const recentOutput = terminalOutput.slice(-50).join('\n');

        // Truncate to max context length
        if (recentOutput.length > this.maxContextLength) {
            this.contextText = recentOutput.slice(-this.maxContextLength);
        } else {
            this.contextText = recentOutput;
        }

        console.log('[ModelScope ASR] Context updated, length:', this.contextText.length);
    }

    /**
     * Start streaming recognition
     */
    public async startStreamingRecognition(): Promise<void> {
        if (!this.apiKey) {
            this.emit('error', new Error('ModelScope API key not configured'));
            return;
        }

        this.isRecording = true;
        this.audioBuffer = [];

        try {
            // Initialize streaming session with ModelScope
            const response = await axios.post(
                `${this.apiUrl}audio/transcriptions/stream`,
                {
                    model: this.model,
                    language: this.language,
                    stream: true,
                    context: this.contextText,
                    enable_itn: false, // Disable inverse text normalization
                    response_format: 'json'
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'X-DashScope-SSE': 'enable' // Enable server-sent events for streaming
                    }
                }
            );

            this.streamingSession = response.data;
            console.log('[ModelScope ASR] Streaming session started');

        } catch (error) {
            console.error('[ModelScope ASR] Failed to start streaming:', error);
            this.emit('error', error);
        }
    }

    /**
     * Send audio chunk for recognition
     */
    public async sendAudioChunk(audioData: Buffer): Promise<void> {
        if (!this.isRecording || !this.apiKey) {
            return;
        }

        this.audioBuffer.push(audioData);

        // Accumulate some audio before sending (e.g., 100ms worth)
        if (this.audioBuffer.length >= 3) {
            const combinedBuffer = Buffer.concat(this.audioBuffer);
            this.audioBuffer = [];

            try {
                // Convert audio to base64
                const base64Audio = combinedBuffer.toString('base64');

                // Send to ModelScope API
                const response = await axios.post(
                    `${this.apiUrl}audio/transcriptions`,
                    {
                        model: this.model,
                        audio: base64Audio,
                        language: this.language,
                        context: this.contextText,
                        stream: true,
                        response_format: 'json'
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        responseType: 'stream'
                    }
                );

                // Handle streaming response
                response.data.on('data', (chunk: Buffer) => {
                    try {
                        const lines = chunk.toString().split('\n').filter(line => line.trim());
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const data = line.slice(6);
                                if (data === '[DONE]') {
                                    continue;
                                }
                                const parsed = JSON.parse(data);

                                if (parsed.text) {
                                    const result: TranscriptionResult = {
                                        text: parsed.text,
                                        isFinal: parsed.is_final || false,
                                        timestamp: Date.now()
                                    };

                                    if (result.isFinal) {
                                        this.emit('final', result.text);
                                    } else {
                                        this.emit('partial', result.text);
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error('[ModelScope ASR] Error parsing stream data:', err);
                    }
                });

            } catch (error) {
                console.error('[ModelScope ASR] Failed to send audio chunk:', error);
                this.emit('error', error);
            }
        }
    }

    /**
     * Stop recognition
     */
    public stopRecognition(): void {
        this.isRecording = false;
        this.audioBuffer = [];
        this.streamingSession = null;
        console.log('[ModelScope ASR] Recognition stopped');
    }

    /**
     * Check if API is properly configured
     */
    public isConfigured(): boolean {
        return !!this.apiKey;
    }

    /**
     * Get current context
     */
    public getContext(): string {
        return this.contextText;
    }

    /**
     * Set maximum context length
     */
    public setMaxContextLength(length: number): void {
        this.maxContextLength = Math.min(Math.max(100, length), 10000);
    }
}