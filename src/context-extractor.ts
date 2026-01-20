export interface ExtractedContext {
    techTerms: string[];
    filePaths: string[];
    recentCommands: string[];
    codeKeywords: string[];
}

export class ContextExtractor {
    private static readonly TECH_PATTERNS = {
        functions: /\b(function|const|let|var|class|interface|type|enum)\s+(\w+)/g,
        imports: /\b(import|require|from)\s+['"]([\w\-\/@]+)['"]/g,
        packages: /\b(npm|yarn|pnpm|pip|cargo|go get)\s+(install|add|i)\s+([\w\-@\/]+)/g,
        fileExtensions: /\b\w+\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|h|hpp|css|html|json|yaml|yml|md)\b/g,
        commands: /\$\s*(\w+)/g,
        chinese: /[\u4e00-\u9fa5]+/g,
    };

    private static readonly COMMON_TECH_TERMS = [
        'React', 'TypeScript', 'JavaScript', 'Python', 'Rust', 'Go',
        'Docker', 'Kubernetes', 'Git', 'GitHub', 'npm', 'yarn',
        'async', 'await', 'promise', 'callback', 'API', 'REST',
        'GraphQL', 'WebSocket', 'HTTP', 'HTTPS', 'TCP', 'UDP',
        'frontend', 'backend', 'database', 'server', 'client',
        'component', 'module', 'package', 'library', 'framework',
        'Claude', 'gogogo', 'terminal', 'console', 'debug',
    ];

    static extractFromBuffer(buffer: string[], limit: number = 100): ExtractedContext {
        const recentLines = buffer.slice(-limit).join('\n');

        const techTerms = new Set<string>();
        const filePaths = new Set<string>();
        const commands = new Set<string>();
        const codeKeywords = new Set<string>();

        this.COMMON_TECH_TERMS.forEach(term => techTerms.add(term));

        let match;

        while ((match = this.TECH_PATTERNS.functions.exec(recentLines)) !== null) {
            if (match[2]) codeKeywords.add(match[2]);
        }

        this.TECH_PATTERNS.imports.lastIndex = 0;
        while ((match = this.TECH_PATTERNS.imports.exec(recentLines)) !== null) {
            if (match[2]) techTerms.add(match[2]);
        }

        this.TECH_PATTERNS.packages.lastIndex = 0;
        while ((match = this.TECH_PATTERNS.packages.exec(recentLines)) !== null) {
            if (match[3]) techTerms.add(match[3]);
        }

        this.TECH_PATTERNS.fileExtensions.lastIndex = 0;
        while ((match = this.TECH_PATTERNS.fileExtensions.exec(recentLines)) !== null) {
            if (match[0]) filePaths.add(match[0]);
        }

        this.TECH_PATTERNS.commands.lastIndex = 0;
        while ((match = this.TECH_PATTERNS.commands.exec(recentLines)) !== null) {
            if (match[1]) commands.add(match[1]);
        }

        const pathMatches = recentLines.match(/[\.\/]?(?:[\w\-]+\/)+[\w\-\.]+/g);
        if (pathMatches) {
            pathMatches.forEach(path => {
                if (path.length > 3 && path.includes('/')) {
                    filePaths.add(path);
                }
            });
        }

        return {
            techTerms: Array.from(techTerms).slice(0, 50),
            filePaths: Array.from(filePaths).slice(0, 20),
            recentCommands: Array.from(commands).slice(0, 10),
            codeKeywords: Array.from(codeKeywords).slice(0, 30),
        };
    }

    static generateHotwords(context: ExtractedContext): Array<{ word: string; boost: number }> {
        const hotwords: Array<{ word: string; boost: number }> = [];

        context.techTerms.forEach(term => {
            hotwords.push({ word: term, boost: 2.0 });
        });

        context.codeKeywords.forEach(keyword => {
            hotwords.push({ word: keyword, boost: 3.0 });
        });

        context.filePaths.forEach(path => {
            const filename = path.split('/').pop();
            if (filename) {
                hotwords.push({ word: filename, boost: 2.5 });
            }
        });

        context.recentCommands.forEach(cmd => {
            hotwords.push({ word: cmd, boost: 1.5 });
        });

        hotwords.push({ word: 'gogogo', boost: 4.0 });
        hotwords.push({ word: 'Claude', boost: 3.5 });
        hotwords.push({ word: '语音', boost: 3.0 });
        hotwords.push({ word: '识别', boost: 3.0 });
        hotwords.push({ word: '输入', boost: 2.5 });

        return hotwords.slice(0, 100);
    }

    static compressContext(buffer: string[], maxTokens: number = 200): string {
        const context = this.extractFromBuffer(buffer);

        const parts: string[] = [];

        if (context.techTerms.length > 0) {
            parts.push(`Tech: ${context.techTerms.slice(0, 10).join(', ')}`);
        }

        if (context.codeKeywords.length > 0) {
            parts.push(`Code: ${context.codeKeywords.slice(0, 10).join(', ')}`);
        }

        if (context.recentCommands.length > 0) {
            parts.push(`Commands: ${context.recentCommands.slice(0, 5).join(', ')}`);
        }

        const recentText = buffer.slice(-10).join(' ').substring(0, 500);
        if (recentText) {
            parts.push(`Recent: ${recentText}`);
        }

        const compressed = parts.join(' | ');

        const words = compressed.split(/\s+/);
        if (words.length > maxTokens) {
            return words.slice(0, maxTokens).join(' ');
        }

        return compressed;
    }
}