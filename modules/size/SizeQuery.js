const Query = require("../types/Query");
const Utils = require("../Utils");

class SizeQuery extends Query {
    constructor(video, audioOnly, videoOnly, format, environment) {
        super(environment, video.identifier);
        this.video = video;
        this.audioOnly = audioOnly;
        this.videoOnly = videoOnly;
        this.audioQuality = environment.mainAudioQuality;
        this.format = format
    }

    async connect() {
    const forceH264 = (this.environment.settings.outputFormat === "mp4");
    const forceMp3 = (this.environment.settings.audioOutputFormat === "mp3");
    const encoding = forceH264 ? "[vcodec=h264]" : (this.video.selectedEncoding === "none" ? "" : "[vcodec=" + this.video.selectedEncoding + "]");
    // When forcing MP4 prefer AAC for audio codec in estimations
    const audioEncoding = forceH264 ? "[acodec=aac]" : (forceMp3 ? "[acodec=mp3]" : (this.video.selectedAudioEncoding === "none" ? "" : "[acodec=" + this.video.selectedAudioEncoding + "]"));
    let formatArgument = `bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}]+${this.audioQuality}audio${audioEncoding}/best[height=${this.format.height}]/bestvideo+bestaudio/best`;
        if(this.videoOnly) {
            formatArgument = `bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}/bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}/bestvideo[height=${this.format.height}]${encoding}/best[height=${this.format.height}]/bestvideo/best`;
            if (this.format.fps == null) {
                formatArgument = `bestvideo[height=${this.format.height}]${encoding}/bestvideo[height=${this.format.height}]${encoding}/best[height=${this.format.height}]/bestvideo/best`
            }
        } else {
            formatArgument = `bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}][fps=${this.format.fps}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}]+${this.video.audioQuality}audio${audioEncoding}/best[height=${this.format.height}]/bestvideo+bestaudio/best`;
            if (this.format.fps == null) {
                formatArgument = `bestvideo[height=${this.format.height}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/bestvideo[height=${this.format.height}]${encoding}+${this.video.audioQuality}audio${audioEncoding}/best[height=${this.format.height}]/bestvideo+bestaudio/best`
            }
        }
        if(this.audioOnly) {
            if (forceMp3) {
                formatArgument = `bestaudio[acodec=mp3]/bestaudio/best`;
            } else {
                formatArgument = `bestaudio/bestaudio/best`;
            }
        }

        let output = await this.environment.metadataLimiter.schedule(() => this.start(this.video.url, ["-J", "--flat-playlist", "-f", formatArgument]));
        let data = JSON.parse(output);
        let totalSize = 0;
        if(data.requested_formats != null) {
            if(this.audioOnly) {
                for (const requestedFormat of data.requested_formats) {
                    if (requestedFormat.vcodec === "none") {
                        totalSize += requestedFormat.filesize;
                        break;
                    }
                }
            } else if(this.videoOnly) {
                for (const requestedFormat of data.requested_formats) {
                    if (requestedFormat.acodec === "none") {
                        totalSize += requestedFormat.filesize;
                        break;
                    }
                }
            } else {
                for (const requestedFormat of data.requested_formats) {
                    if (requestedFormat.filesize != null) {
                        totalSize += requestedFormat.filesize;
                    } else if (requestedFormat.filesize_approx != null) {
                        totalSize += requestedFormat.filesize_approx;
                    }
                }
            }
        }
        if(totalSize === 0) {
            if(!this.audioOnly && !this.videoOnly) {
                this.format.filesize = null;
                this.format.filesize_label = "Unknown";
            }
            return "Unknown";
        } else {
            if(!this.audioOnly && !this.videoOnly) {
                this.format.filesize = totalSize;
                this.format.filesize_label = Utils.convertBytes(totalSize);
            }
            return totalSize
        }
    }
}

module.exports = SizeQuery;
