/**
 * Typing Indicator Utility
 * 
 * Provides a messenger-style typing indicator (three animated dots)
 * for visual feedback during LLM and FlexSearch operations.
 */

class TypingIndicator {
    constructor() {
        this.isActive = false;
        this.intervalId = null;
        this.frame = 0;
        this.frames = ['.  ', '.. ', '...', ' ..', '  .', '   '];
    }

    /**
     * Start the typing indicator animation
     */
    start() {
        if (this.isActive) {
            return;
        }

        this.isActive = true;
        this.frame = 0;

        // Hide cursor
        process.stdout.write('\x1B[?25l');

        this.intervalId = setInterval(() => {
            const dots = this.frames[this.frame];
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(dots);
            this.frame = (this.frame + 1) % this.frames.length;
        }, 150);
    }

    /**
     * Stop the typing indicator and clear the line
     */
    stop() {
        if (!this.isActive) {
            return;
        }

        clearInterval(this.intervalId);
        this.intervalId = null;
        this.isActive = false;

        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);

        // Show cursor again
        process.stdout.write('\x1B[?25h');
    }

    /**
     * Check if the indicator is currently active
     */
    isRunning() {
        return this.isActive;
    }
}

// Create a singleton instance
const typingIndicator = new TypingIndicator();

/**
 * Start typing indicator
 */
export function startTyping() {
    typingIndicator.start();
}

/**
 * Stop typing indicator
 */
export function stopTyping() {
    typingIndicator.stop();
}

/**
 * Check if typing indicator is running
 */
export function isTyping() {
    return typingIndicator.isRunning();
}

export default typingIndicator;