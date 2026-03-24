class VideoPlayer {
    constructor(container, src = '') {
        this.container = container;
        this.src = src;
        
        // Create elements
        this.createElements();
        this.setupEventListeners();
        this.updateTimeDisplay();
    }
    
    createElements() {
        // Main wrapper
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'video-player-wrapper';
        
        // Video element
        this.video = document.createElement('video');
        this.video.className = 'video-player-video';
        if (this.src) {
            this.video.src = this.src;
        }
        
        // Controls container
        this.controls = document.createElement('div');
        this.controls.className = 'video-player-controls';
        
        // Play/Pause button
        this.playPauseBtn = document.createElement('button');
        this.playPauseBtn.className = 'video-player-btn play-pause-btn';
        this.playPauseBtn.innerHTML = '▶'; // Play symbol
        this.playPauseBtn.title = 'Play/Pause (Space)';
        
        // Time display
        this.timeDisplay = document.createElement('div');
        this.timeDisplay.className = 'video-player-time';
        this.timeDisplay.textContent = '0:00 / 0:00';
        
        // Seek bar
        this.seekBar = document.createElement('input');
        this.seekBar.type = 'range';
        this.seekBar.className = 'video-player-seek';
        this.seekBar.min = '0';
        this.seekBar.max = '100';
        this.seekBar.value = '0';
        
        // Volume controls
        this.muteBtn = document.createElement('button');
        this.muteBtn.className = 'video-player-btn mute-btn';
        this.muteBtn.innerHTML = '🔊'; // Speaker symbol
        this.muteBtn.title = 'Mute/Unmute (M)';
        
        this.volumeSlider = document.createElement('input');
        this.volumeSlider.type = 'range';
        this.volumeSlider.className = 'video-player-volume';
        this.volumeSlider.min = '0';
        this.volumeSlider.max = '100';
        this.volumeSlider.value = '100';
        
        // Playback speed selector
        this.speedSelector = document.createElement('select');
        this.speedSelector.className = 'video-player-speed';
        this.speedSelector.innerHTML = `
            <option value="0.5">0.5x</option>
            <option value="1" selected>1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
        `;
        
        // Fullscreen button
        this.fullscreenBtn = document.createElement('button');
        this.fullscreenBtn.className = 'video-player-btn fullscreen-btn';
        this.fullscreenBtn.innerHTML = '⛶'; // Fullscreen symbol
        this.fullscreenBtn.title = 'Fullscreen (F)';
        
        // Assemble controls
        this.controls.appendChild(this.playPauseBtn);
        this.controls.appendChild(this.timeDisplay);
        this.controls.appendChild(this.seekBar);
        this.controls.appendChild(this.muteBtn);
        this.controls.appendChild(this.volumeSlider);
        this.controls.appendChild(this.speedSelector);
        this.controls.appendChild(this.fullscreenBtn);
        
        // Assemble wrapper
        this.wrapper.appendChild(this.video);
        this.wrapper.appendChild(this.controls);
        
        // Add to container
        this.container.appendChild(this.wrapper);
    }
    
    setupEventListeners() {
        // Play/Pause
        this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
        this.video.addEventListener('play', () => {
            this.playPauseBtn.innerHTML = '⏸'; // Pause symbol
        });
        this.video.addEventListener('pause', () => {
            this.playPauseBtn.innerHTML = '▶'; // Play symbol
        });
        
        // Time updates
        this.video.addEventListener('loadedmetadata', () => this.updateTimeDisplay());
        this.video.addEventListener('timeupdate', () => this.updateTimeDisplay());
        
        // Seek bar
        this.seekBar.addEventListener('input', (e) => {
            const seekTime = (e.target.value / 100) * this.video.duration;
            this.video.currentTime = seekTime;
        });
        
        // Volume
        this.muteBtn.addEventListener('click', () => this.toggleMute());
        this.volumeSlider.addEventListener('input', (e) => {
            this.video.volume = e.target.value / 100;
            this.updateVolumeIcon();
        });
        
        // Speed
        this.speedSelector.addEventListener('change', (e) => {
            this.video.playbackRate = parseFloat(e.target.value);
        });
        
        // Fullscreen
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeypress(e));
        
        // Update seek bar on video progress
        this.video.addEventListener('timeupdate', () => {
            if (this.video.duration) {
                this.seekBar.value = (this.video.currentTime / this.video.duration) * 100;
            }
        });
    }
    
    togglePlayPause() {
        if (this.video.paused) {
            this.video.play();
        } else {
            this.video.pause();
        }
    }
    
    toggleMute() {
        this.video.muted = !this.video.muted;
        this.updateVolumeIcon();
    }
    
    updateVolumeIcon() {
        if (this.video.muted || this.video.volume === 0) {
            this.muteBtn.innerHTML = '🔇'; // Muted symbol
        } else if (this.video.volume < 0.5) {
            this.muteBtn.innerHTML = '🔉'; // Low volume symbol
        } else {
            this.muteBtn.innerHTML = '🔊'; // High volume symbol
        }
    }
    
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            if (this.wrapper.requestFullscreen) {
                this.wrapper.requestFullscreen();
            } else if (this.wrapper.webkitRequestFullscreen) {
                this.wrapper.webkitRequestFullscreen();
            } else if (this.wrapper.msRequestFullscreen) {
                this.wrapper.msRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
    }
    
    handleKeypress(e) {
        // Only handle if this video player is focused or visible
        if (!this.wrapper.contains(document.activeElement) && 
            !this.isElementInViewport(this.wrapper)) {
            return;
        }
        
        switch(e.key) {
            case ' ':
                e.preventDefault();
                this.togglePlayPause();
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
    
    isElementInViewport(el) {
        const rect = el.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }
    
    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
    
    updateTimeDisplay() {
        const current = this.formatTime(this.video.currentTime);
        const duration = this.formatTime(this.video.duration);
        this.timeDisplay.textContent = `${current} / ${duration}`;
    }
    
    // Public methods
    load(src) {
        this.src = src;
        this.video.src = src;
    }
    
    play() {
        return this.video.play();
    }
    
    pause() {
        this.video.pause();
    }
    
    destroy() {
        document.removeEventListener('keydown', this.handleKeypress);
        this.wrapper.remove();
    }
}

export default VideoPlayer;