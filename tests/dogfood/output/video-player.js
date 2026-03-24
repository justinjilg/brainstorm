/**
 * Custom HTML5 Video Player Component
 * Creates a fully-featured video player with custom controls
 */
class VideoPlayer {
    /**
     * Create a new VideoPlayer instance
     * @param {HTMLElement} container - Container element for the player
     * @param {Object} options - Configuration options
     * @param {string} options.src - Video source URL
     * @param {string} options.poster - Poster image URL
     * @param {boolean} options.autoplay - Whether to autoplay the video
     * @param {boolean} options.loop - Whether to loop the video
     * @param {boolean} options.muted - Whether to start muted
     * @param {boolean} options.controls - Whether to show native controls (default: false, uses custom controls)
     */
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            src: options.src || '',
            poster: options.poster || '',
            autoplay: options.autoplay || false,
            loop: options.loop || false,
            muted: options.muted || false,
            controls: options.controls || false,
        };

        this.isPlaying = false;
        this.isMuted = this.options.muted;
        this.isFullscreen = false;
        this.playbackRate = 1.0;
        this.volume = this.isMuted ? 0 : 0.7;

        this.init();
        this.bindEvents();
    }

    /**
     * Initialize the player DOM structure
     */
    init() {
        // Create main player container
        this.player = document.createElement('div');
        this.player.className = 'video-player';
        this.player.tabIndex = 0; // Make focusable for keyboard shortcuts

        // Create video element
        this.video = document.createElement('video');
        this.video.className = 'video-player__video';
        this.video.src = this.options.src;
        this.video.poster = this.options.poster;
        this.video.autoplay = this.options.autoplay;
        this.video.loop = this.options.loop;
        this.video.muted = this.options.muted;
        this.video.controls = this.options.controls;
        this.video.preload = 'metadata';

        // Create controls container
        this.controls = document.createElement('div');
        this.controls.className = 'video-player__controls';

        // Create play/pause button
        this.playPauseBtn = document.createElement('button');
        this.playPauseBtn.className = 'video-player__btn video-player__play-pause';
        this.playPauseBtn.innerHTML = '▶';
        this.playPauseBtn.setAttribute('aria-label', 'Play/Pause');

        // Create time display
        this.timeDisplay = document.createElement('div');
        this.timeDisplay.className = 'video-player__time';
        this.timeDisplay.innerHTML = '00:00 / 00:00';

        // Create seek bar
        this.seekBar = document.createElement('input');
        this.seekBar.className = 'video-player__seek';
        this.seekBar.type = 'range';
        this.seekBar.min = '0';
        this.seekBar.max = '100';
        this.seekBar.value = '0';
        this.seekBar.setAttribute('aria-label', 'Seek video');

        // Create volume controls container
        this.volumeContainer = document.createElement('div');
        this.volumeContainer.className = 'video-player__volume-container';

        // Create mute button
        this.muteBtn = document.createElement('button');
        this.muteBtn.className = 'video-player__btn video-player__mute';
        this.muteBtn.innerHTML = this.isMuted ? '🔇' : '🔊';
        this.muteBtn.setAttribute('aria-label', 'Mute/Unmute');

        // Create volume slider
        this.volumeSlider = document.createElement('input');
        this.volumeSlider.className = 'video-player__volume';
        this.volumeSlider.type = 'range';
        this.volumeSlider.min = '0';
        this.volumeSlider.max = '100';
        this.volumeSlider.value = this.isMuted ? '0' : '70';
        this.volumeSlider.setAttribute('aria-label', 'Volume');

        // Create playback speed selector
        this.speedSelect = document.createElement('select');
        this.speedSelect.className = 'video-player__speed';
        this.speedSelect.setAttribute('aria-label', 'Playback speed');
        
        const speeds = [
            { value: 0.5, label: '0.5x' },
            { value: 1.0, label: '1x' },
            { value: 1.5, label: '1.5x' },
            { value: 2.0, label: '2x' }
        ];
        
        speeds.forEach(speed => {
            const option = document.createElement('option');
            option.value = speed.value;
            option.textContent = speed.label;
            if (speed.value === 1.0) option.selected = true;
            this.speedSelect.appendChild(option);
        });

        // Create fullscreen button
        this.fullscreenBtn = document.createElement('button');
        this.fullscreenBtn.className = 'video-player__btn video-player__fullscreen';
        this.fullscreenBtn.innerHTML = '⛶';
        this.fullscreenBtn.setAttribute('aria-label', 'Toggle fullscreen');

        // Assemble controls
        this.volumeContainer.appendChild(this.muteBtn);
        this.volumeContainer.appendChild(this.volumeSlider);

        this.controls.appendChild(this.playPauseBtn);
        this.controls.appendChild(this.timeDisplay);
        this.controls.appendChild(this.seekBar);
        this.controls.appendChild(this.volumeContainer);
        this.controls.appendChild(this.speedSelect);
        this.controls.appendChild(this.fullscreenBtn);

        // Assemble player
        this.player.appendChild(this.video);
        this.player.appendChild(this.controls);

        // Clear container and append player
        this.container.innerHTML = '';
        this.container.appendChild(this.player);

        // Set initial volume
        this.video.volume = this.volume;
    }

    /**
     * Bind event listeners
     */
    bindEvents() {
        // Video events
        this.video.addEventListener('loadedmetadata', () => this.updateDuration());
        this.video.addEventListener('timeupdate', () => this.updateTime());
        this.video.addEventListener('play', () => this.setPlaying(true));
        this.video.addEventListener('pause', () => this.setPlaying(false));
        this.video.addEventListener('ended', () => this.setPlaying(false));
        this.video.addEventListener('volumechange', () => this.updateVolume());

        // Control events
        this.playPauseBtn.addEventListener('click', () => this.togglePlay());
        this.seekBar.addEventListener('input', () => this.seek());
        this.muteBtn.addEventListener('click', () => this.toggleMute());
        this.volumeSlider.addEventListener('input', () => this.changeVolume());
        this.speedSelect.addEventListener('change', () => this.changeSpeed());
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

        // Keyboard shortcuts
        this.player.addEventListener('keydown', (e) => this.handleKeydown(e));

        // Click video to play/pause
        this.video.addEventListener('click', () => this.togglePlay());
    }

    /**
     * Toggle play/pause state
     */
    togglePlay() {
        if (this.video.paused) {
            this.video.play();
        } else {
            this.video.pause();
        }
    }

    /**
     * Set playing state and update button
     * @param {boolean} playing - Whether video is playing
     */
    setPlaying(playing) {
        this.isPlaying = playing;
        this.playPauseBtn.innerHTML = playing ? '⏸' : '▶';
        this.playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    /**
     * Update time display and seek bar
     */
    updateTime() {
        const currentTime = this.video.currentTime;
        const duration = this.video.duration || 0;
        
        // Update seek bar
        const percent = duration ? (currentTime / duration) * 100 : 0;
        this.seekBar.value = percent;

        // Update time display
        this.timeDisplay.innerHTML = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
    }

    /**
     * Update duration display
     */
    updateDuration() {
        this.updateTime();
    }

    /**
     * Seek video based on seek bar position
     */
    seek() {
        const percent = this.seekBar.value;
        const duration = this.video.duration || 0;
        this.video.currentTime = (percent / 100) * duration;
    }

    /**
     * Toggle mute state
     */
    toggleMute() {
        this.isMuted = !this.isMuted;
        this.video.muted = this.isMuted;
        
        if (this.isMuted) {
            this.muteBtn.innerHTML = '🔇';
            this.muteBtn.setAttribute('aria-label', 'Unmute');
            this.volumeSlider.value = '0';
        } else {
            this.muteBtn.innerHTML = '🔊';
            this.muteBtn.setAttribute('aria-label', 'Mute');
            this.volumeSlider.value = this.volume * 100;
        }
    }

    /**
     * Change volume based on slider
     */
    changeVolume() {
        const volume = parseInt(this.volumeSlider.value) / 100;
        this.volume = volume;
        this.video.volume = volume;
        this.video.muted = volume === 0;
        this.isMuted = volume === 0;
        
        this.muteBtn.innerHTML = volume === 0 ? '🔇' : '🔊';
        this.muteBtn.setAttribute('aria-label', volume === 0 ? 'Unmute' : 'Mute');
    }

    /**
     * Update volume display when video volume changes
     */
    updateVolume() {
        if (!this.video.muted) {
            this.volume = this.video.volume;
            this.volumeSlider.value = this.volume * 100;
        }
    }

    /**
     * Change playback speed
     */
    changeSpeed() {
        this.playbackRate = parseFloat(this.speedSelect.value);
        this.video.playbackRate = this.playbackRate;
    }

    /**
     * Toggle fullscreen mode
     */
    toggleFullscreen() {
        if (!this.isFullscreen) {
            if (this.player.requestFullscreen) {
                this.player.requestFullscreen();
            } else if (this.player.webkitRequestFullscreen) {
                this.player.webkitRequestFullscreen();
            } else if (this.player.mozRequestFullScreen) {
                this.player.mozRequestFullScreen();
            } else if (this.player.msRequestFullscreen) {
                this.player.msRequestFullscreen();
            }
            this.isFullscreen = true;
            this.fullscreenBtn.innerHTML = '⛶';
            this.fullscreenBtn.setAttribute('aria-label', 'Exit fullscreen');
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
            this.isFullscreen = false;
            this.fullscreenBtn.innerHTML = '⛶';
            this.fullscreenBtn.setAttribute('aria-label', 'Enter fullscreen');
        }
    }

    /**
     * Handle keyboard shortcuts
     * @param {KeyboardEvent} e - Keyboard event
     */
    handleKeydown(e) {
        // Only handle shortcuts when player is focused
        if (document.activeElement !== this.player) return;

        switch (e.key) {
            case ' ':
            case 'Spacebar':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'm':
            case 'M':
                e.preventDefault();
                this.toggleMute();
                break;
            case 'f':
            case 'F':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.video.currentTime = Math.max(0, this.video.currentTime - 5);
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 5);
                break;
        }
    }

    /**
     * Format time in MM:SS format
     * @param {number} seconds - Time in seconds
     * @returns {string} Formatted time string
     */
    formatTime(seconds) {
        if (isNaN(seconds) || !isFinite(seconds)) return '00:00';
        
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Load a new video source
     * @param {string} src - New video source URL
     */
    load(src) {
        this.video.src = src;
        this.video.load();
    }

    /**
     * Play the video
     */
    play() {
        this.video.play();
    }

    /**
     * Pause the video
     */
    pause() {
        this.video.pause();
    }

    /**
     * Set video source
     * @param {string} src - Video source URL
     */
    setSrc(src) {
        this.options.src = src;
        this.load(src);
    }

    /**
     * Destroy the player and clean up
     */
    destroy() {
        // Remove event listeners
        this.video.removeEventListener('loadedmetadata', () => this.updateDuration());
        this.video.removeEventListener('timeupdate', () => this.updateTime());
        this.video.removeEventListener('play', () => this.setPlaying(true));
        this.video.removeEventListener('pause', () => this.setPlaying(false));
        this.video.removeEventListener('ended', () => this.setPlaying(false));
        this.video.removeEventListener('volumechange', () => this.updateVolume());

        // Remove player from DOM
        if (this.player.parentNode) {
            this.player.parentNode.removeChild(this.player);
        }
    }
}

export default VideoPlayer;