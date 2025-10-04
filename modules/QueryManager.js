const InfoQuery = require("./info/InfoQuery");
const Video = require("./types/Video");
const Utils = require("./Utils");
const InfoQueryList = require("./info/InfoQueryList");
const ProgressBar = require("./types/ProgressBar");
const DownloadQuery = require("./download/DownloadQuery");
const { shell, dialog } = require('electron');
const axios = require('axios')
const path = require('path')
const url = require('url');
const fs = require("fs");
const SizeQuery = require("./size/SizeQuery");
const DownloadQueryList = require("./download/DownloadQueryList");
const Format = require("./types/Format");
const DoneAction = require("./DoneAction");

class QueryManager {
    constructor(window, environment) {
        this.window = window;
        this.environment = environment;
        this.managedVideos = [];
        this.playlistMetadata = [];
    }

    // Sanitize incoming URLs so radio links are truncated and playlist handling
    // respects the user's saved preference in settings. This ensures any code
    // path that calls manage() can't bypass sanitization.
    sanitizeUrl(u) {
        if(!u || typeof u !== 'string') return u;
        let out = u.trim();
        const lower = out.toLowerCase();

        // If it's a radio style link (contains 'radio' in URL), truncate at
        // the first ampersand to avoid expanding into huge auto-playlists.
        if(lower.includes('radio')) {
            const ampIndex = out.indexOf('&');
            if(ampIndex > -1) out = out.substring(0, ampIndex);
            return out;
        }

        // If it contains a playlist parameter, consult settings. If the user
        // has chosen to default to the single video, strip the query part.
        try {
            const hasList = /[?&]list=/i.test(out);
            if(hasList) {
                const pref = this.environment && this.environment.settings ? this.environment.settings.playlistDefault : null;
                if(pref === 'video') {
                    const ampIndex = out.indexOf('&');
                    if(ampIndex > -1) out = out.substring(0, ampIndex);
                }
                // If pref is 'playlist' or 'ask' we leave the link as-is so
                // downstream logic (renderer prompt or default playlist flow)
                // can handle it.
            }
        } catch(e) {
            // Silently ignore and return original URL in case of unexpected errors
        }

        return out;
    }

    async manage(url) {
        // Ensure URL is sanitized by main-process policy (radio truncation, playlist default)
        const sanitizedUrl = this.sanitizeUrl(url);
        let metadataVideo = new Video(sanitizedUrl, "metadata", this.environment);
        this.addVideo(metadataVideo);
        const initialQuery = await new InfoQuery(sanitizedUrl, metadataVideo.identifier, this.environment).connect();
        if(metadataVideo.error) return;
        if(Utils.isYouTubeChannel(sanitizedUrl)) {
            const actualQuery = await new InfoQuery(initialQuery.entries[0].url, metadataVideo.identifier, this.environment).connect();
            if(metadataVideo.error) return;
            this.removeVideo(metadataVideo);
            if(actualQuery.entries == null || actualQuery.entries.length === 0) this.managePlaylist(initialQuery, sanitizedUrl);
            else this.managePlaylist(actualQuery, initialQuery.entries[0].url);
            return;
        }

        switch(Utils.detectInfoType(initialQuery)) {
            case "single":
                this.manageSingle(initialQuery, sanitizedUrl);
                this.removeVideo(metadataVideo);
                break;
            case "playlist":
                this.managePlaylist(initialQuery, sanitizedUrl);
                this.removeVideo(metadataVideo);
                break;
            case "livestream":
                this.environment.errorHandler.raiseError({code: "Nãp suportado", description: "Live ainda não são suportadas, apenas VOD gravadas e processadas."}, metadataVideo.identifier);
                break;
            default:
                //This.environment.errorHandler.raiseUnhandledError("Youtube-dl returned an empty object\n" + JSON.stringify(Utils.detectInfoType(initialQuery), null, 2), metadataVideo.identifier);
                break;
        }
    }

    manageSingle(initialQuery, url) {
        let video = new Video(url, "single", this.environment);
        video.setMetadata(initialQuery);
        this.addVideo(video);
        setTimeout(() => this.updateGlobalButtons(), 700); //This feels kinda hacky, maybe find a better way sometime.
    }

    managePlaylist(initialQuery, url) {
        this.playlistMetadata = this.playlistMetadata.concat(Utils.generatePlaylistMetadata(initialQuery));
        let playlistVideo = new Video(url, "playlist", this.environment);
        this.addVideo(playlistVideo);
        const playlistQuery = new InfoQueryList(initialQuery, this.environment, new ProgressBar(this, playlistVideo));
        playlistQuery.start().then((videos) => {
            if(videos.length > this.environment.settings.splitMode) {
                let totalFormats = [];
                let totalAudioCodecs = [];
                playlistVideo.videos = videos;
                for(const video of videos) {
                    for(const audioCodec of video.audioCodecs) {
                        if(!totalAudioCodecs.includes(audioCodec)) {
                            totalAudioCodecs.push(audioCodec);
                        }
                    }
                    for(const format of video.formats) {
                        format.display_name = Format.getDisplayName(format.height, format.fps);
                        totalFormats.push(format);
                    }
                }
                //Dedupe totalFormats by height and fps
                totalFormats = totalFormats.filter((v,i,a) => a.findIndex(t=>(t.height === v.height && t.fps === v.fps))===i);
                //Sort totalFormats DESC by height and fps
                totalFormats.sort((a, b) => b.height - a.height || b.fps - a.fps);
                const title = initialQuery.title == null ? url : initialQuery.title;
                const uploader = initialQuery.uploader == null ? "Unknown" : initialQuery.uploader;
                if(this.window != null) {
                    this.window.webContents.send("videoAction", {
                        action: "setUnified",
                        identifier: playlistVideo.identifier,
                        formats: totalFormats,
                        subtitles: this.environment.mainDownloadSubs,
                        thumb: videos[0].thumbnail,
                        audioCodecs: totalAudioCodecs,
                        title: title,
                        length: videos.length,
                        uploader: uploader,
                        url: playlistVideo.url
                    })
                }
            } else {
                this.removeVideo(playlistVideo);
                for (const video of videos) {
                    this.addVideo(video);
                }
            }
            setTimeout(() => this.updateGlobalButtons(), 700); //This feels kinda hacky, maybe find a better way sometime.
            setTimeout(() => this.updateGlobalButtons(), 2000); //This feels even more hacky, maybe find a better way sometime.
        });
    }

    addVideo(video) {
        this.managedVideos.push(video);
        let formats = [];
        if(video.hasMetadata) {
            for(const format of video.formats) {
                formats.push(format.serialize());
            }
        }
        let args = {
            action: "add",
            type: video.type,
            identifier:  video.identifier,
            url: video.url,
            title: video.title,
            duration: video.duration,
            durationSeconds: video.durationSeconds,
            audioOnly: video.audioOnly,
            subtitles: video.downloadSubs,
            loadSize: this.environment.settings.sizeMode === "full",
            hasFilesizes: video.hasFilesizes,
            audioCodecs: video.audioCodecs,
            formats: formats,
            selected_format_index: (video.hasMetadata) ? video.selected_format_index : null,
            thumbnail: video.thumbnail
        }
        this.window.webContents.send("videoAction", args);
    }

    downloadVideo(args) {
        let downloadVideo = this.getVideo(args.identifier);
        // Apply trim instructions if provided
        if(args.trimStart != null) downloadVideo.trimStart = args.trimStart;
        if(args.trimEnd != null) downloadVideo.trimEnd = args.trimEnd;
        downloadVideo.selectedEncoding = args.encoding;
        downloadVideo.selectedAudioEncoding = args.audioEncoding;
        downloadVideo.audioOnly = args.type === "audio";
        downloadVideo.videoOnly = args.type === "videoOnly";
        if(!downloadVideo.audioOnly) {
            for (const format of downloadVideo.formats) {
                if (format.getDisplayName() === args.format) {
                    downloadVideo.selected_format_index = downloadVideo.formats.indexOf(format);
                    break;
                }
            }
        }
        downloadVideo.audioQuality = (downloadVideo.audioQuality != null) ? downloadVideo.audioQuality : "best";
        let progressBar = new ProgressBar(this, downloadVideo);
        downloadVideo.setQuery(new DownloadQuery(downloadVideo.url, downloadVideo, this.environment, progressBar, this.playlistMetadata));
        downloadVideo.query.connect().then(() => {
            //Backup done call, sometimes it does not trigger automatically from within the downloadQuery.
            if(downloadVideo.error) return;
            if(this.environment.settings.downloadJsonMetadata) this.saveInfo(downloadVideo.identifier, false);
            downloadVideo.downloaded = true;
            downloadVideo.query.progressBar.done(downloadVideo.audioOnly);
            this.updateGlobalButtons();
        });
    }

    downloadAllVideos(args) {
        let videosToDownload = [];
        let unifiedPlaylists = [];
        let videoMetadata = [];
        for(const videoObj of args.videos) {
            let video = this.getVideo(videoObj.identifier);
            // Apply per-video trim instructions if provided from the renderer
            if(videoObj.trimStart != null) video.trimStart = videoObj.trimStart;
            if(videoObj.trimEnd != null) video.trimEnd = videoObj.trimEnd;
            video.selectedEncoding = videoObj.encoding;
            video.selectedAudioEncoding = videoObj.audioEncoding;
            if(video.videos == null) {
                if(video.downloaded || video.type !== "single") continue;
                video.audioOnly = videoObj.type === "audio";
                video.videoOnly = videoObj.type === "videoOnly";
                if(video.audioOnly) {
                    video.audioQuality = videoObj.format;
                } else {
                    for (const format of video.formats) {
                        if (format.getDisplayName() === videoObj.format) {
                            video.selected_format_index = video.formats.indexOf(format);
                            break;
                        }
                    }
                }
                const videoMeta = Utils.getVideoInPlaylistMetadata(video.url, null, this.playlistMetadata);
                if(videoMeta != null) {
                    videoMetadata.push(videoMeta);
                }
                video.audioQuality = (video.audioQuality != null) ? video.audioQuality : "best";
                videosToDownload.push(video);
            } else {
                video.url = videoObj.url;
                unifiedPlaylists.push(video);
                this.getUnifiedVideos(video, video.videos, videoObj.type === "audio", videoObj.format, videoObj.downloadSubs);
                for(const unifiedVideo of video.videos) {
                    // If the unified playlist entry had trimming info, propagate it to each child video
                    if(videoObj.trimStart != null) unifiedVideo.trimStart = videoObj.trimStart;
                    if(videoObj.trimEnd != null) unifiedVideo.trimEnd = videoObj.trimEnd;
                    const videoMeta = Utils.getVideoInPlaylistMetadata(unifiedVideo.url, video.url, this.playlistMetadata);
                    if(videoMeta != null) {
                        videoMetadata.push(videoMeta);
                    }
                    unifiedVideo.parentID = video.identifier;
                    unifiedVideo.parentSize = video.videos.length;
                    videosToDownload.push(unifiedVideo);
                }
            }
        }
        let progressBar = new ProgressBar(this, "queue");
        let downloadList = new DownloadQueryList(videosToDownload, videoMetadata, this.environment, this, progressBar);
        for(const unifiedPlaylist of unifiedPlaylists) { unifiedPlaylist.setQuery(downloadList) }
        downloadList.start().then(() => {
            for(const unifiedPlaylist of unifiedPlaylists) { unifiedPlaylist.downloaded = true }
            this.updateGlobalButtons();
            const doneAction = new DoneAction();
            doneAction.executeAction(this.environment.doneAction);
        })
    }

    getUnifiedVideos(playlist, videos, audioOnly, selectedFormat, subtitles) {
        playlist.audioOnly = audioOnly
        if(!playlist.audioOnly) {
            for (const video of videos) {
                video.downloadSubs = subtitles;
                let gotFormatMatch = false;
                for (const format of video.formats) {
                    if (format.getDisplayName() === selectedFormat) {
                        video.selected_format_index = video.formats.indexOf(format);
                        gotFormatMatch = true;
                        break;
                    }
                }
                if (!gotFormatMatch) {
                    const suppliedFormat = Format.getFromDisplayName(selectedFormat);
                    const output = video.formats.reduce((prev, curr) => Math.abs(curr.height - suppliedFormat.height) < Math.abs(prev.height - suppliedFormat.height) ? curr : prev);
                    video.selected_format_index = video.formats.indexOf(output);
                }
            }
        } else {
            for(const video of videos) {
                video.downloadSubs = subtitles;
                video.audioOnly = true;
                video.audioQuality = (playlist.audioQuality != null) ? playlist.audioQuality : "best";
            }
        }
        playlist.audioQuality = (playlist.audioQuality != null) ? playlist.audioQuality : "best";
    }

    downloadUnifiedPlaylist(args) {
        const playlist = this.getVideo(args.identifier);
        const videos = playlist.videos;
        const metadata = videos.map(vid => Utils.getVideoInPlaylistMetadata(vid.url, playlist.url, this.playlistMetadata)).filter(entry => entry != null);
        this.getUnifiedVideos(playlist, videos, args.type === "audio", args.format, playlist.downloadSubs);
        playlist.audioQuality = (playlist.audioQuality != null) ? playlist.audioQuality : "best";
        let progressBar = new ProgressBar(this, playlist);
        playlist.setQuery(new DownloadQueryList(videos, metadata, this.environment, this, progressBar));
        playlist.query.start().then(() => {
            //Backup done call, sometimes it does not trigger automatically from within the downloadQuery.
            playlist.downloaded = true;
            playlist.query.progressBar.done(playlist.audioOnly);
            this.updateGlobalButtons();
        });
    }

    async getSize(identifier, formatLabel, audioOnly, videoOnly, clicked, encoding, audioEncoding) {
        const video = this.getVideo(identifier);
        video.selectedEncoding = encoding;
        video.selectedAudioEncoding = audioEncoding;
        const cachedSize = this.getCachedSize(video, formatLabel, audioOnly, videoOnly);
        if(cachedSize != null) {
            //The size for this format was already looked up
            return cachedSize;
        } else {
            //Size was not already looked up
            //Try looking it up
            if(!clicked && this.environment.settings.sizeMode === "click") {
                //The sizemode is click so when the lookup from renderer is initial it should not do anything.
                return null;
            } else {
                return await this.querySize(video, formatLabel, video.getFormatFromLabel(formatLabel), audioOnly, videoOnly);
            }
        }
    }

    async querySize(video, formatLabel, format, audioOnly, videoOnly) {
        const sizeQuery = new SizeQuery(video, audioOnly, videoOnly, audioOnly ? formatLabel : format, this.environment);
        const result = await sizeQuery.connect();
        if(audioOnly) {
            if(formatLabel === "best") {
                video.bestAudioSize = result
            } else {
                video.worstAudioSize = result
            }
        } else if(videoOnly) {
            const formatCopy = Format.getFromDisplayName(formatLabel);
            formatCopy.filesize = result;
            video.videoOnlySizeCache.push(formatCopy);
        }
        return result;
    }

    getCachedSize(video, formatLabel, audioOnly, videoOnly) {
        if(audioOnly) {
            let applicableSize;
            if (formatLabel === "best") applicableSize = video.bestAudioSize;
            else applicableSize = video.worstAudioSize;
            return applicableSize;
        } else if(videoOnly) {
            const cachedFormat = video.videoOnlySizeCache.find(format => format.getDisplayName() === formatLabel);
            if(cachedFormat != null) return cachedFormat.filesize;
            else return null;
        } else {
            return video.getFormatFromLabel(formatLabel).filesize;
        }
    }

    removeVideo(video) {
        this.managedVideos = this.managedVideos.filter(item => item.identifier !== video.identifier);
        this.playlistMetadata = this.playlistMetadata.filter(item => item.video_url !== video.url);
        this.window.webContents.send("videoAction", { action: "remove", identifier: video.identifier })
        this.environment.logger.clear(video.identifier);
    }

    onError(identifier) {
        let video = this.getVideo(identifier);
        if(video.query != null) {
            video.query.cancel();
        }
        video.error = true;
        this.updateGlobalButtons();
    }

    updateProgress(video, progress_args) {
        let args;
        if(video === "queue") {
            args = {
                action: "totalProgress",
                identifier: video.identifier,
                progress: progress_args
            }
        } else {
            args = {
                action: "progress",
                identifier: video.identifier == null ? video : video.identifier,
                url: video.url,
                progress: progress_args
            }
        }
        try {
            this.window.webContents.send("videoAction", args);
        } catch(e) {
            console.log("Blocked webContents IPC call, the window object was destroyed.");
        }
    }

    stopDownload(identifier) {
        let video = this.getVideo(identifier);
        if (video.query != null) {
            video.query.cancel();
        }
        this.removeVideo(video);
    }

    async openVideo(args) {
        let video = this.getVideo(args.identifier);
        let file = video.filename;
        let fallback = false;
        if(video.type === "playlist") {
            shell.openPath(video.downloadedPath);
            return;
        }
        if(file == null) {
            try {
                const files = await fs.promises.readdir(video.downloadedPath);
                for (const searchFile of files) {
                    const base = searchFile.substring(0, searchFile.lastIndexOf('.'));
                    if (base === video.getFilename()) {
                        file = searchFile;
                        break;
                    }
                }
                if (file == null) {
                    fallback = true;
                    file = video.getFilename() + ".mp4";
                }
            } catch (err) {
                // If we couldn't read the directory, fallback to constructed filename
                fallback = true;
                file = video.getFilename() + ".mp4";
            }
        }
        if(args.type === "folder") {
            if(fallback) {
                shell.openPath(video.downloadedPath);
            } else {
                shell.showItemInFolder(await this.verifyOpenVideoFilepath(video, file));
            }
        } else if(args.type === "item") {
            shell.openPath(await this.verifyOpenVideoFilepath(video, file));
        } else {
            console.error("Wrong openVideo type specified.")
        }
    }

    async verifyOpenVideoFilepath(video, file) {
        const videoPath = path.resolve(path.join(video.downloadedPath, file));
        try {
            await fs.promises.access(videoPath);
            return videoPath;
        } catch (e) {
            let extension = file.substring(file.lastIndexOf('.'), file.length);
            if(!extension || extension.indexOf('.') === -1) extension = '.mp4';
            //Fallback to constructed filename
            const fallbackPath = path.resolve(path.join(video.downloadedPath, video.getFilename() + extension));
            return fallbackPath;
        }
    }

    getUnifiedAvailableSubtitles(videos) {
        let totalSubs = [];
        let totalAutoGen = [];
        for(const video of videos) {
            if(video.subtitles != null && video.subtitles.length !== 0) {
                totalSubs = totalSubs.concat(Object.keys(video.subtitles).map(sub => {
                    return {iso: sub, name: Utils.getNameFromISO(sub)};
                }))
            }
            if(video.autoCaptions != null && video.autoCaptions.length !== 0) {
                totalAutoGen = totalAutoGen.concat(Object.keys(video.autoCaptions).map(sub => {
                    return {iso: sub, name: Utils.getNameFromISO(sub)};
                }))
            }
        }
        const totalSubsDedupe = Utils.dedupeSubtitles(totalSubs);
        const totalAutoGenDedupe = Utils.dedupeSubtitles(totalAutoGen);
        return [totalSubsDedupe.sort(Utils.sortSubtitles), totalAutoGenDedupe.sort(Utils.sortSubtitles)];
    }

    getAvailableSubtitles(identifier, unified) {
        const video = this.getVideo(identifier);
        if(unified) {
            return this.getUnifiedAvailableSubtitles(video.videos);
        }
        let subs = [];
        let autoGen = [];
        if(video.subtitles != null && video.subtitles.length !== 0) {
            subs = Object.keys(video.subtitles).map(sub => {
                return {iso: sub, name: Utils.getNameFromISO(sub)};
            })
        }
        if(video.autoCaptions != null && video.autoCaptions.length !== 0) {
            autoGen = Object.keys(video.autoCaptions).map(sub => {
                return {iso: sub, name: Utils.getNameFromISO(sub)};
            })
        }
        return [subs.sort(Utils.sortSubtitles), autoGen.sort(Utils.sortSubtitles)];
    }

    getSelectedSubtitles(identifier) {
        const video = this.getVideo(identifier);
        return video.selectedSubs;
    }

    showInfo(identifier) {
        let video = this.getVideo(identifier);
        let args = {
            action: "info",
            metadata: video.hasMetadata ? video.serialize() : null,
            identifier: identifier
        };
        this.window.webContents.send("videoAction", args);
    }

    async saveInfo(infoVideo, askPath=true) {
        let video = infoVideo;
        if(video.url == null) video = this.getVideo(infoVideo);
        if (video.url == null) return;
        let result = { filePath: path.join(this.environment.settings.downloadPath, "metadata_" + video.url.slice(-11)) + ".json",  };
        if (askPath) {
            result = await dialog.showSaveDialog(this.window, {
                defaultPath: path.join(this.environment.settings.downloadPath, "metadata_" + video.url.slice(-11)),
                buttonLabel: "Save metadata",
                filters: [
                    {name: "JSON", extensions: ["json"]},
                    {name: "All Files", extensions: ["*"]},
                ],
                properties: ["createDirectory"]
            });
        }
        if(!result.canceled) {
            fs.writeFileSync(result.filePath, JSON.stringify(video.serialize(), null, 3));
        }
    }

    async saveThumb(link) {
        let result = await dialog.showSaveDialog(this.window, {
            defaultPath: path.join(this.environment.settings.downloadPath, "thumb_" + path.basename(url.parse(link).pathname)),
            buttonLabel: "Save thumbnail",
            filters: [
                { name: "Images", extensions: ["jpeg", "jpg", "png", "webp", "tiff", "bmp"] },
                { name: "All Files", extensions: ["*"] },
            ],
            properties: ["createDirectory"]
        });
        if(!result.canceled) {
            const path = result.filePath;
            const writer = fs.createWriteStream(path);
            const response = await axios.get(link,{ responseType: "stream" });
            response.data.pipe(writer);
        }
    }

    updateGlobalButtons() {
        let videos = [];
        for(const video of this.managedVideos) {
            let downloadable = this.isDownloadable(video);
            videos.push({identifier: video.identifier, downloadable: downloadable})
        }
        this.window.webContents.send("updateGlobalButtons", videos);
    }

    setUnifiedSubtitle(videos, args) {
        for(const video of videos) {
            video.downloadSubs = args.enabled;
            video.selectedSubs = [args.subs, args.autoGen];
            video.subLanguages = [...new Set([...args.subs, ...args.autoGen])];
        }
    }

    setSubtitle(args) {
        const video = this.getVideo(args.identifier);
        if(args.unified) {
            this.setUnifiedSubtitle(video.videos, args);
        }
        video.downloadSubs = args.enabled;
        video.selectedSubs = [args.subs, args.autoGen];
        video.subLanguages = [...new Set([...args.subs, ...args.autoGen])];
    }

    setGlobalSubtitle(value) {
        this.environment.mainDownloadSubs = value;
        for(const video of this.managedVideos) {
            video.downloadSubs = value;
        }
    }

    isDownloadable(video) {
        let usedVideo = video;
        if(video.type == null) {
            usedVideo = this.getVideo(video);
        }
        if(usedVideo.videos != null && !usedVideo.downloaded) return true;
        return !(usedVideo == null || usedVideo.type !== "single" || usedVideo.error || usedVideo.downloaded)
    }

    getVideo(identifier) {
        return this.managedVideos.find(item => {
            return item.identifier === identifier;
        });
    }

    getTaskList() {
        const urlList = []
        const filteredUrlList = [];
        for(const video of this.managedVideos) {
            urlList.push(video.url)
        }
        for(const video of this.playlistMetadata) {
            for(let i = 0; i < urlList.length; i++) {
                if(urlList[i] === video.video_url || urlList[i] === video.playlist_url) {
                    urlList.splice(i, 1);
                    i--;
                    filteredUrlList.push(video.playlist_url);
                } else {
                    filteredUrlList.push(urlList[i]);
                }
            }
        }
        const dedupedFilteredUrlList = [...new Set(filteredUrlList)];
        if(dedupedFilteredUrlList.length === 0) {
            return urlList;
        } else {
            return dedupedFilteredUrlList;
        }
    }

    loadTaskList(taskList) {
        let count = 0;
        for(const url of taskList) {
            this.manage(url);
            count++;
        }
        console.log("Added " + count + " saved tasks.")
    }

}
module.exports = QueryManager;
