import reblessed from 'reblessed';
import os from 'node:os';

// Reblessed-compatible theme colors
export const theme = {
    secondary: 'grey',
    text: 'white',
    primary: 'bright-blue',
    warning: 'yellow',
    success: 'green',
    error: 'red',
};



// Constants for file reading animation
export const BOX_CHARS = {
    TL: '╭', TR: '╮', BL: '╰', BR: '╯', H: '─', V: '│'
};

let thinkingWidget = null;
let hintWidget = null;
let loadingInterval = null;

/**
 * Displays an inline, animated loading indicator with a cancel hint.
 * @param {reblessed.Screen} screen The main screen object.
 * @param {string} text The text to display.
 */
export function showLoading(screen, text = 'Thinking...') {
    if (thinkingWidget) {
        hideLoading(screen);
    }

    const frames = [' .  ', ' .. ', ' ...', '..  '];
    let frameIndex = 0;

    thinkingWidget = reblessed.box({
        parent: screen,
        bottom: 5, // Positioned in the space above the input box
        height: 1,
        width: 'shrink',
        left: 1,
        tags: true,
        style: {
            fg: theme.warning,
        }
    });

    hintWidget = reblessed.box({
        parent: screen,
        bottom: 4, // Positioned directly above the input box
        height: 1,
        width: 'shrink',
        left: 1,
        tags: true,
        content: `{${theme.secondary}-fg}(Press Esc to cancel){/}`,
    });

    // Start the animation interval
    loadingInterval = setInterval(() => {
        if (!thinkingWidget) {
            clearInterval(loadingInterval);
            loadingInterval = null;
            return;
        }
        frameIndex = (frameIndex + 1) % frames.length;
        thinkingWidget.setContent(`${text}${frames[frameIndex]}`);
        screen.render();
    }, 200);

    screen.render();
}

/**
 * Hides the inline loading indicator and hint.
 * @param {reblessed.Screen} screen The main screen object.
 */
export function hideLoading(screen) {
    if (loadingInterval) {
        clearInterval(loadingInterval);
        loadingInterval = null;
    }
    if (thinkingWidget) {
        thinkingWidget.destroy();
        thinkingWidget = null;
    }
    if (hintWidget) {
        hintWidget.destroy();
        hintWidget = null;
        screen.render();
    }
}

// Helper to strip ANSI color codes to calculate visible string length
export const stripAnsi = (str) => str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

// Helper to create a static boxed message
export function createBoxedMessage(content) {
    const padding = 2;
    const visibleContentLength = stripAnsi(content).length;
    const boxWidth = visibleContentLength + padding * 2;

    // Using reblessed tags for colors
    const topBorder = `{${theme.secondary}-fg}${BOX_CHARS.TL}${BOX_CHARS.H.repeat(boxWidth)}${BOX_CHARS.TR}{/}`;
    const contentLine = `{${theme.secondary}-fg}${BOX_CHARS.V}{/} ${' '.repeat(padding - 1)}${content}${' '.repeat(padding)} {${theme.secondary}-fg}${BOX_CHARS.V}{/}`;
    const bottomBorder = `{${theme.secondary}-fg}${BOX_CHARS.BL}${BOX_CHARS.H.repeat(boxWidth)}${BOX_CHARS.BR}{/}`;
    return `${topBorder}\n${contentLine}\n${bottomBorder}`;
}

/**
 * Stops the "reading file" animation and returns a completion message string for success or failure.
 * @param {number} id The ID of the animation to stop.
 * @param {Error|null} [error=null] - An optional error object. If provided, a failure message will be generated.
 * @returns {string|null} The completion message, or null if the animation was not found.
 */

/**
 * Displays the application intro screen in the log widget.
 * @param {reblessed.Log} log The log widget to print to.
 */
export const displayIntro = (log) => {
    const ploinkyArt = [
        ' ____  _      ____  ___  _   _  _  __ __   __',
        '|  _ \\| |    / __ \\|_ _|| \\ | || |/ / \\ \\ / /',
        '| |_) | |   | |  | || | |  \\| || \' /   \\ V /',
        '|  __/| |   | |  | || | | . ` ||  <     > /',
        '| |   | |___| |__| || | | |\\  || . \\   / /',
        '|_|   |______\\____/|___||_| \\_||_|\\_\\ /_/'
    ];

    log.log(`{${theme.primary}-fg}${ploinkyArt.join('\n')}{/}`);
    log.log('');
    log.log(`Welcome to Ploinky, your AI-powered command-line assistant.`);
    log.log('');
    log.log(`  {${theme.secondary}-fg}•{/} Configure your LLM and provider using the {${theme.warning}-fg}/configure{/} command.`);
    log.log(`  {${theme.secondary}-fg}•{/} Type {${theme.warning}-fg}/help{/} for a list of all available commands.`);
    log.log('');
};

/**
 * Updates the content of a reblessed status bar widget.
 * @param {reblessed.Box} statusBar The status bar widget.
 * @param {object} config The application configuration.
 */
export const updateStatusBar = (statusBar, config) => {
    const provider = config?.provider || 'N/A';
    const model = config?.model || 'N/A';
    const CWD = process.cwd();
    const homeDir = os.homedir();
    let displayPath = CWD;
    if (displayPath.startsWith(homeDir)) {
        displayPath = '~' + displayPath.substring(homeDir.length);
    }

    const leftText = `{${theme.secondary}-fg}${displayPath}{/}`;
    const rightText = `{${theme.secondary}-fg}${provider} | ${model}{/}`;
    statusBar.setContent(`${leftText} ${rightText.padStart(statusBar.width - stripAnsi(leftText).length - 1)}`);
};

/**
 * Creates an interactive selection menu with arrow key navigation
 * @param {Object} options Configuration for the menu
 * @param {string} options.title The title to display above the menu
 * @param {string} options.instructions Instructions for using the menu
 * @param {Array} options.items Array of items to select from
 * @param {function} options.formatItem Function to format each item for display
 * @param {number} [options.initialIndex=0] Initial selected index
 * @param {reblessed.Screen} options.screen The main screen object.
 * @returns {Promise<Object|null>} The selected item or null if cancelled
 */
export const createInteractiveMenu = (options) => {
    return new Promise((resolve) => {
        const {
            title,
            items,
            formatItem = (item) => item.toString(),
            screen,
        } = options;
        const formattedItems = items.map(item => stripAnsi(formatItem(item, false)));
        
        const list = reblessed.list({
            parent: screen,
            label: ` ${title} `,
            top: 'center',
            left: 'center',
            width: '80%',
            height: '70%',
            items: formattedItems,
            keys: true,
            vi: true, // vi-style navigation
            mouse: false, // Disable mouse support to prevent hover-selection
            grabKeys: true, // Lock all keypresses to this widget
            border: 'line',
            scrollable: true,
            interactive: true,
            style: {
                fg: theme.text,
                border: { fg: theme.primary },
                selected: { bg: theme.primary, fg: 'black' },
                label: { fg: theme.text, bg: theme.primary }
            }
        });

        list.on('select', (item, index) => {
            list.destroy();
            resolve(items[index]);
        });
        list.on('cancel', () => {
            list.destroy();
            resolve(null);
        });

        screen.append(list);
        list.focus();
        screen.render();
    });
};
