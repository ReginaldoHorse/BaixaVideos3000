const Query = require("../types/Query")
const path = require("path")
const fs = require("fs");
const Utils = require("../Utils")
const console = require("console");

class DownloadQuery extends Query {
    constructor(url, video, environment, progressBar, playlistMeta) {
        super(environment, video.identifier);
        this.playlistMeta = playlistMeta;
        this.url = url;
        this.video = video;
        this.progressBar = progressBar;
        this.format = video.formats[video.selected_format_index];
    }

    cancel() {
        super.stop();
    }

    async connect() {
        let downloadFolderPath = this.environment.settings.downloadPath;

        if(this.environment.settings.avoidFailingToSaveDuplicateFileName) {
            downloadFolderPath += `/[${this.video.identifier}]`;
        }

        let args = [];
        let output = path.join(downloadFolderPath, Utils.resolvePlaylistPlaceholders(this.environment.settings.nameFormat, this.playlistMeta));
        const PROGRESS_TEMPLATE = '[download] %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s %(progress)j';

        if(this.video.audioOnly) {
            let audioQuality = this.video.audioQuality;
            if(audioQuality === "best") {
                audioQuality = "0";
            } else if(audioQuality === "worst") {
                audioQuality = "9";
            }
            const audioOutputFormat = this.environment.settings.audioOutputFormat || "mp3";
            args = [
                '--extract-audio', '--audio-quality', audioQuality,
                '--ffmpeg-location', this.environment.paths.ffmpeg,
                '--no-mtime',
                '-o', output,
                '--output-na-placeholder', "",
                '--progress-template', PROGRESS_TEMPLATE
            ];
            if(this.video.selectedAudioEncoding !== "none") {
                args.push("-f");
                args.push("bestaudio[acodec=" + this.video.selectedAudioEncoding + "]/bestaudio");
            } else if(audioOutputFormat === "m4a") {
                args.push("-f");
                args.push("bestaudio[ext=m4a]/bestaudio");
            }
            if(audioOutputFormat !== "none") {
                args.push('--audio-format', audioOutputFormat);
            }
            // If a trim is requested for audio-only, pass trimming args to ffmpeg via postprocessor-args
            if((this.video.trimStart != null || this.video.trimEnd != null) && audioOutputFormat !== "none") {
                args.push('--postprocessor-args');
                let postArgs = '';
                if(this.video.trimStart) postArgs += `-ss ${this.video.trimStart} `;
                if(this.video.trimEnd) postArgs += `-to ${this.video.trimEnd} `;
                // encode to requested audio format
                if(audioOutputFormat === 'mp3') {
                    postArgs += '-c:a libmp3lame -b:a 192k -progress pipe:1 -nostats';
                } else if(audioOutputFormat === 'm4a' || audioOutputFormat === 'aac') {
                    postArgs += '-c:a aac -b:a 192k -progress pipe:1 -nostats';
                } else {
                    postArgs += '-progress pipe:1 -nostats';
                }
                // Log the postprocessor args for debugging
                try { this.environment.logger.log(this.video.identifier, '[postArgs][audio] ' + postArgs); } catch(e) {}
                // Ensure args are routed to ffmpeg post-processor explicitly
                args.push('ffmpeg:' + postArgs.trim());
            }
            if(audioOutputFormat === "m4a" || audioOutputFormat === "mp3" || audioOutputFormat === "none") {
                // Ensure thumbnails are converted to PNG before embedding to reduce failures
                args.push("--convert-thumbnails");
                args.push("png");
                args.push("--embed-thumbnail");
            }
        } else {
            if (this.video.formats.length !== 0) {
                let format;
                const encoding = (this.environment.settings.outputFormat === "mp4") ? "[vcodec=h264]" : (this.video.selectedEncoding === "none" ? "" : "[vcodec=" + this.video.selectedEncoding + "]");
                const audioEncoding = "";
                if(this.video.videoOnly) {
                    format = `
                    bestvideo[height=${this.format.height}][fps=${this.format.fps}][ext=mp4]${encoding}
                    /bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}
                    /bestvideo[height=${this.format.height}][fps=${this.format.fps}]
                    /bestvideo[height=${this.format.height}]
                    /best[height=${this.format.height}]
                    /bestvideo
                    /best`;
                    if (this.format.fps == null) {
                        format = `
                        bestvideo[height=${this.format.height}][ext=mp4]${encoding}
                        /bestvideo[height=${this.format.height}]${encoding}
                        /bestvideo[height=${this.format.height}]
                        /best[height=${this.format.height}]
                        /bestvideo
                        /best`
                    }
                } else {
                    format = `
                    bestvideo[height=${this.format.height}][fps=${this.format.fps}][ext=mp4]${encoding}+${this.video.audioQuality}audio[ext=m4a]${audioEncoding}
                    /bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.video.audioQuality}audio${audioEncoding}
                    /bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.video.audioQuality}audio
                    /bestvideo[height=${this.format.height}][fps=${this.format.fps}]+${this.video.audioQuality}audio
                    /bestvideo[height=${this.format.height}]+${this.video.audioQuality}audio
                    /best[height=${this.format.height}]
                    /bestvideo+bestaudio
                    /best`;
                    if (this.format.fps == null) {
                        format = `
                        bestvideo[height=${this.format.height}][ext=mp4]${encoding}+${this.video.audioQuality}audio[ext=m4a]${audioEncoding}
                        /bestvideo[height=${this.format.height}]${encoding}+${this.video.audioQuality}audio${audioEncoding}
                        /bestvideo[height=${this.format.height}]${encoding}+${this.video.audioQuality}audio
                        /bestvideo[height=${this.format.height}]+${this.video.audioQuality}audio
                        /best[height=${this.format.height}]
                        /bestvideo+bestaudio
                        /best`
                    }
                }
                args = [
                    "-f", format,
                    "-o", output,
                    '--ffmpeg-location', this.environment.paths.ffmpeg,
                    '--no-mtime',
                    '--output-na-placeholder', "",
                    '--progress-template', PROGRESS_TEMPLATE
                ];
                if (this.environment.settings.outputFormat === "mp4") {
                    // Re-encode video to H.264 and audio to AAC to ensure editor compatibility
                    args.push('--postprocessor-args');
                    let postArgs = '-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 192k -progress pipe:1 -nostats';
                    if(this.video.trimStart != null || this.video.trimEnd != null) {
                        // Prefix trimming args so they appear together before encoding flags
                        let trimPrefix = '';
                        if(this.video.trimStart) trimPrefix += `-ss ${this.video.trimStart} `;
                        if(this.video.trimEnd) trimPrefix += `-to ${this.video.trimEnd} `;
                        postArgs = trimPrefix + postArgs;
                    }
                    // Log the postprocessor args for debugging
                    try { this.environment.logger.log(this.video.identifier, '[postArgs][video] ' + postArgs); } catch(e) {}
                    // Ensure args are routed to ffmpeg post-processor explicitly
                    args.push('ffmpeg:' + postArgs.trim());
                } else if (this.environment.settings.audioOutputFormat === "mp3") {
                    args.push('--postprocessor-args');
                    let postArgs = '-c:a libmp3lame -b:a 192k -progress pipe:1 -nostats';
                    if(this.video.trimStart != null || this.video.trimEnd != null) {
                        if(this.video.trimStart) postArgs = `-ss ${this.video.trimStart} ` + postArgs;
                        if(this.video.trimEnd) postArgs = postArgs + ` -to ${this.video.trimEnd}`;
                    }
                    try { this.environment.logger.log(this.video.identifier, '[postArgs][audio-branch] ' + postArgs); } catch(e) {}
                    // Ensure args are routed to ffmpeg post-processor explicitly
                    args.push('ffmpeg:' + postArgs.trim());
                }
            } else {
                args = [
                    "-o", output,
                    '--ffmpeg-location', this.environment.paths.ffmpeg,
                    '--no-mtime',
                    '--output-na-placeholder', "",
                    '--progress-template', PROGRESS_TEMPLATE
                ];
            }
            if (this.video.downloadSubs && this.video.subLanguages.length > 0) {
                this.progressBar.setInitial("Downloading subtitles");
                args.push("--write-sub");
                args.push("--write-auto-sub");
                args.push("--embed-subs");
                args.push("--sub-lang");
                let langs = "";
                this.video.subLanguages.forEach(lang => langs += lang + ",")
                args.push(langs.slice(0, -1));
            }
            if (this.environment.settings.outputFormat !== "none") {
                args.push("--merge-output-format");
                args.push(this.environment.settings.outputFormat);
            }
        }
        if(this.environment.settings.downloadMetadata) {
            args.push('--add-metadata');
        }
        if(this.environment.settings.downloadThumbnail) {
            args.push('--write-thumbnail');
        }
        if(this.environment.settings.sponsorblockMark !== "") {
            args.push("--sponsorblock-mark");
            args.push(this.environment.settings.sponsorblockMark);
        }

        if(this.environment.settings.sponsorblockRemove !== "") {
            args.push("--sponsorblock-remove");
            args.push(this.environment.settings.sponsorblockRemove);
        }

        if(this.environment.settings.keepUnmerged || this.environment.settings.avoidFailingToSaveDuplicateFileName) {
            args.push('--keep-video');
        }

        if(this.environment.settings.retries) {
            args.push('--retries');
            args.push(this.environment.settings.retries);
        }

        let destinationCount = 0;
        let initialReset = false;
        let result = null;
            try {
            // Log the full args we will call yt-dlp with for debugging
            try { this.environment.logger.log(this.video.identifier, '[yt-dlp args] ' + JSON.stringify(args)); } catch(e) {}
            result = await this.environment.downloadLimiter.schedule(() => this.start(this.url, args, (liveData) => {
                this.environment.logger.log(this.video.identifier, liveData);
                this.video.setFilename(liveData);

                // Allow both youtube-dl/yt-dlp '[download]' lines and ffmpeg key=value progress lines
                const isDownloadLine = liveData.includes("[download]");
                const isFfmpegKvLine = liveData.includes('=') && (liveData.includes('out_time') || liveData.includes('out_time_ms') || liveData.includes('progress') || liveData.includes('time='));
                if (!isDownloadLine && !isFfmpegKvLine) return;

                if (liveData.includes("Destination")) destinationCount += 1;

                if (!initialReset) {
                    initialReset = true;
                    this.progressBar.reset();
                    return;
                }

                if (destinationCount === 2 && !this.video.audioOnly && !this.video.downloadingAudio) {
                    this.video.downloadingAudio = true;
                    this.progressBar.reset();
                    return;
                }

                // Try parsing youtube-dl/yt-dlp JSON progress first
                let liveDataObj;
                try {
                    if (liveData.includes('{')) {
                        liveDataObj = JSON.parse(liveData.slice(liveData.indexOf('{')));
                    }
                } catch(e) {
                    liveDataObj = null;
                }

                
                if (!this._ffmpegMessageTimerStarted && (liveData.includes('out_time') || liveData.includes('out_time_ms'))) {
                    this._ffmpegMessageTimerStarted = true;
                    this._ffmpegMessageInterval = null;
                    // Start a 20s timeout to begin rotating messages
                    this._ffmpegMessageTimeout = setTimeout(() => {
                        const msgs = [
                            "Aguente aí, estou tornando o arquivo compatível",
                            "Demora um pouquinho mas é útil",
                            "Esse arquivo será compatível com tudo",
                            "A plataforma de vídeos vermelha adora atrapalhar"
                        ];
                        let idx = 0;
                        this.progressBar.setInitial("Convertendo com FFmpeg");
                        this._ffmpegMessageInterval = setInterval(() => {
                            this.progressBar.setInitial(msgs[idx % msgs.length]);
                            idx += 1;
                        }, 8000);
                    }, 20000);
                }
                if (liveData && liveData.includes('=')) {
                    const kv = {};
                    const lines = liveData.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                    for (const line of lines) {
                        const parts = line.split('=');
                        if (parts.length === 2) kv[parts[0]] = parts[1];
                    }
                    // ffmpeg progress provides 'out_time_ms' or 'out_time' and 'progress'
                    if (kv.out_time_ms || kv.out_time) {
                        const outMs = kv.out_time_ms ? parseInt(kv.out_time_ms, 10) : (() => {
                            const t = kv.out_time.split(':');
                            return (parseInt(t[0],10)*3600 + parseInt(t[1],10)*60 + Math.floor(parseFloat(t[2]))) * 1000;
                        })();
                        if (this.video.durationSeconds) {
                            const completion = Math.min(outMs / (this.video.durationSeconds * 1000), 1);
                            const percentage = Math.floor(completion * 100) + "." + (Math.floor(completion * 1000) % 10) + "%";
                            // estimate remaining seconds
                            const elapsed = outMs / 1000;
                            const remaining = Math.max(0, this.video.durationSeconds - elapsed);
                            const eta = new Date(remaining * 1000).toISOString().substr(11, 8);
                            this.progressBar.updateDownload(percentage, eta, null, this.video.audioOnly || this.video.downloadingAudio);
                            return;
                        }
                    }
                }

                // Fall back to youtube-dl progress JSON parsing
                let percentage;
                if (liveDataObj && typeof liveDataObj === "object" &&
                    typeof liveDataObj.fragment_count === "number" &&
                    typeof liveDataObj.fragment_index === "number" &&
                    typeof liveDataObj.downloaded_bytes === "number" &&
                    typeof liveDataObj.total_bytes_estimate === "number") {
                    const completion = Math.min(
                        liveDataObj.downloaded_bytes / liveDataObj.total_bytes_estimate,
                        (liveDataObj.fragment_index + 1) / liveDataObj.fragment_count
                    );
                    percentage = Math.floor(completion * 100) + "." + (Math.floor(completion * 1000) % 10) + "%";
                } else if (liveDataObj && typeof liveDataObj === "object" && typeof liveDataObj._percent_str === "string") {
                    percentage = liveDataObj._percent_str;
                } else {
                    const percentMatch = liveData.match(/(\d{1,3}\.\d)%?/);
                    if (percentMatch) {
                        percentage = percentMatch[1] + "%";
                    } else {
                        percentage = "0.0%";
                    }
                }

                const speed = liveDataObj ? liveDataObj._speed_str : null;
                const eta = liveDataObj && liveDataObj.eta >= 0 ? liveDataObj._eta_str : "00:00";

                this.progressBar.updateDownload(percentage, eta, speed, this.video.audioOnly || this.video.downloadingAudio);
            }));
        } catch (exception) {
            // Some post-processing errors (thumbnail conversion/embed) should not
            // fail the entire download. Detect common thumbnail/embed related
            // messages and treat them as non-fatal: log and continue.
            const msg = String(exception || "");
            const thumbnailErrorIndicators = [
                'EmbedThumbnail', 'Adding thumbnail', 'ThumbnailsConvertor', 'Conversion failed', 'Cannot find', 'Cannot update utime', 'Cannot open'
            ];
            const isThumbnailError = thumbnailErrorIndicators.some(ind => msg.includes(ind));
            if(isThumbnailError) {
                try { this.environment.logger.log(this.video.identifier, '[nonfatal postproc error] ' + msg); } catch(e) {}
                // Clear any ffmpeg message timers
                if(this._ffmpegMessageTimeout) {
                    clearTimeout(this._ffmpegMessageTimeout);
                    this._ffmpegMessageTimeout = null;
                }
                if(this._ffmpegMessageInterval) {
                    clearInterval(this._ffmpegMessageInterval);
                    this._ffmpegMessageInterval = null;
                }
                // continue as if successful (do not return exception)
            } else {
                this.environment.errorHandler.checkError(exception, this.video.identifier);
                // Clear any ffmpeg message timers
                if(this._ffmpegMessageTimeout) {
                    clearTimeout(this._ffmpegMessageTimeout);
                    this._ffmpegMessageTimeout = null;
                }
                if(this._ffmpegMessageInterval) {
                    clearInterval(this._ffmpegMessageInterval);
                    this._ffmpegMessageInterval = null;
                }
                return exception;
            }
        }

        if(this.video.audioOnly) {
            await this.removeThumbnail(".jpg");
        }

        // Clear ffmpeg message timers once finished
        if(this._ffmpegMessageTimeout) {
            clearTimeout(this._ffmpegMessageTimeout);
            this._ffmpegMessageTimeout = null;
        }
        if(this._ffmpegMessageInterval) {
            clearInterval(this._ffmpegMessageInterval);
            this._ffmpegMessageInterval = null;
        }

        if(this.environment.settings.avoidFailingToSaveDuplicateFileName) {
            // Determine the actual filename to move. Prefer the filename reported
            // by yt-dlp/ffmpeg (this.video.filename). If that's not present yet,
            // attempt to discover a file in the temp folder that matches the
            // expected base name. Retry a few times because ffmpeg may still be
            // finalizing the file when this block runs in racey environments.
            const expectedBase = this.video.getFilename();
            const maxRetries = 10;
            const retryDelayMs = 300;
            const pathJoin = require('path').join;
            let candidate = this.video.filename;

            // Determine expected extension for better matching (no leading dot)
            const expectedExt = this.video.audioOnly ? (this.environment.settings.audioOutputFormat || 'mp3') : (this.environment.settings.outputFormat && this.environment.settings.outputFormat !== 'none' ? this.environment.settings.outputFormat : 'mp4');
            const tryFindFile = async () => {
                try {
                    const files = await fs.promises.readdir(downloadFolderPath);
                    // Collect stats for each file to prefer non-empty and newest files
                    const filesInfo = await Promise.all(files.map(async (f) => {
                        try {
                            const st = await fs.promises.stat(path.join(downloadFolderPath, f));
                            return { name: f, size: st.size, mtimeMs: st.mtimeMs };
                        } catch(e) {
                            return { name: f, size: 0, mtimeMs: 0 };
                        }
                    }));
                    try { this.environment.logger.log(this.video.identifier, '[tmpDir files] ' + JSON.stringify(filesInfo)); } catch(e) {}

                    // Prefer exact match to the reported filename (and non-empty)
                    if(candidate) {
                        const exact = filesInfo.find(fi => fi.name === candidate && fi.size > 0);
                        if(exact) return exact.name;
                    }

                    // Prefer files that start with expectedBase, are non-empty and match expected extension when possible
                    const extDot = '.' + expectedExt;
                    let matches = filesInfo.filter(fi => fi.name.startsWith(expectedBase) && fi.size > 0);
                    const extMatches = matches.filter(fi => fi.name.toLowerCase().endsWith(extDot.toLowerCase()));
                    if(extMatches.length > 0) {
                        // Return the newest ext-matching file
                        extMatches.sort((a,b) => b.mtimeMs - a.mtimeMs);
                        return extMatches[0].name;
                    }
                    if(matches.length > 0) {
                        matches.sort((a,b) => b.mtimeMs - a.mtimeMs);
                        return matches[0].name;
                    }

                    // As last resort, pick the largest non-empty file
                    const nonEmpty = filesInfo.filter(fi => fi.size > 0);
                    if(nonEmpty.length > 0) {
                        nonEmpty.sort((a,b) => b.size - a.size);
                        return nonEmpty[0].name;
                    }
                } catch (e) {
                    try { this.environment.logger.log(this.video.identifier, '[tmpDir read error] ' + String(e)); } catch(e2) {}
                    // directory may not exist or not readable yet
                }
                return null;
            }

            let found = null;
            for(let i=0;i<maxRetries;i++) {
                found = await tryFindFile();
                if(found) break;
                await new Promise(r => setTimeout(r, retryDelayMs));
            }

            const toMove = found || (this.video.filename || (expectedBase + '.mp4'));
            try {
                try { this.environment.logger.log(this.video.identifier, '[move attempt] chosen=' + String(toMove) + ' found=' + String(found)); } catch(e) {}
                this.environment.paths.moveFile(downloadFolderPath, this.environment.settings.downloadPath, toMove);
            } catch (e) {
                try { this.environment.logger.log(this.video.identifier, '[move error] ' + String(e)); } catch(e2) {}
                console.error('Failed to move file after download:', e);
                // Fallback: attempt copy then unlink to handle rename failures (locked files on Windows)
                try {
                    const src = path.join(downloadFolderPath, toMove);
                    const dest = path.join(this.environment.settings.downloadPath, toMove);
                    try { this.environment.logger.log(this.video.identifier, '[move fallback] copy src=' + src + ' dest=' + dest); } catch(e3) {}
                    await fs.promises.copyFile(src, dest);
                    try { this.environment.logger.log(this.video.identifier, '[move fallback] copy success'); } catch(e3) {}
                    try { await fs.promises.unlink(src); } catch(e4) { /* ignore unlink error */ }
                } catch(copyErr) {
                    try { this.environment.logger.log(this.video.identifier, '[move fallback error] ' + String(copyErr)); } catch(e3) {}
                }
            }

            if(!this.environment.settings.keepUnmerged) {
                this.removeVideoDataFolder(downloadFolderPath);
            }
        }

        return result;
    }

    async removeThumbnail(extension) {
        const filename = this.video.filename;
        if(filename != null) {
            const filenameExt = path.basename(filename, path.extname(filename)) + extension;
            const filenameAbs = path.join(this.video.downloadedPath, filenameExt);
            try {
                await fs.promises.unlink(filenameAbs);
            } catch(e) {
                console.log("No left-over thumbnail found to remove. (" + filenameExt + ")")
                if(extension !== ".webp") {
                    await this.removeThumbnail(".webp");
                }
            }
        }
    }

    removeVideoDataFolder(folderPath) {
        if(folderPath != null) {
            try {
                fs.rmSync(folderPath, {recursive : true, force : true});
            } catch(e) {
                console.log("No left-over Temp Folder found to remove. (" + folderPath + ")")
            }
        }
    }
}
module.exports = DownloadQuery;
