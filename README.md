# Poptropica AS2 Desktop

A desktop port of the classic Flash-based Poptropica game, built with Electron and PepperFlash.

## Features

- **Full AS2 Flash Support** - Runs the original ActionScript 2 game code
- **Custom Scene System** - Navigate between islands without page reloads
- **Profile Management** - Multiple user profiles with import/export
- **Advanced Sound System** - Volume controls for music, ambient, and effects
- **Auto-Update System** - Seamlessly distribute updates to users
- **Developer Tools** - FFDec integration for SWF modification

## Quick Start

### For Players

1. Download the latest release from [Releases](https://github.com/andrewleewiles/poptropica-as2-desktop/releases)
2. Extract and run Poptropica
3. Updates will install automatically

### For Developers

1. Clone this repository:
   ```bash
   git clone https://github.com/andrewleewiles/poptropica-as2-desktop.git
   cd poptropica-as2-desktop
   ```

2. Follow the [SETUP.md](SETUP.md) guide to install dependencies

3. Run the application:
   ```bash
   cd electron-pepper
   npm start
   ```

## Documentation

- **[SETUP.md](SETUP.md)** - Installation and setup guide
- **[READMEDEV.md](READMEDEV.md)** - Development workflow and architecture
- **[GAME_ANALYSIS.md](GAME_ANALYSIS.md)** - Technical analysis of the game systems
- **[UPDATE_SYSTEM.md](UPDATE_SYSTEM.md)** - Complete update system documentation
- **[UPDATE_QUICKSTART.md](UPDATE_QUICKSTART.md)** - Quick reference for updates

## Distributing Updates

This project includes a complete update distribution system. To release an update:

```bash
# Easy way (automated script)
./release-update.sh 0.1.1

# Or manual way
node create-update-package.js 0.1.1
```

See [UPDATE_QUICKSTART.md](UPDATE_QUICKSTART.md) for details.

## Project Structure

```
poptropica-as2-desktop/
├── content/www.poptropica.com/   # Game assets
│   ├── framework.swf              # Core framework
│   ├── gameplay.swf               # Main gameplay
│   ├── char.swf                   # Character system
│   ├── scenes/                    # Island scenes
│   ├── popups/                    # Popup SWFs
│   └── sound/                     # Audio files
├── electron-pepper/               # Electron application
│   ├── src/
│   │   ├── main.js                # Main process
│   │   ├── preload.js             # Preload script
│   │   ├── auto-updater.js        # Update system
│   │   └── renderer/              # Renderer HTML
│   └── package.json
├── FFDec/                         # Flash decompiler
└── create-update-package.js       # Update packaging tool
```

## Technology Stack

- **Electron 8** - Desktop application framework
- **PepperFlash** - Flash Player for running AS2 content
- **ActionScript 2** - Original game code
- **FFDec** - SWF decompilation and editing
- **Java 21** - Runtime for FFDec

## Key Systems

### Scene Switching
Navigate between islands using `NavigateScene(sceneName)` without page reloads.

### Sound System
Advanced audio with XML configuration and volume control:
- Master volume
- Music volume
- Ambient volume
- Effects volume

### Profile Management
Multiple user profiles with save/load functionality and import/export support.

### Auto-Updater
Automatic update checking and installation:
- Checks hourly for new versions
- Downloads and installs updates seamlessly
- Prompts user to restart after installation

## Development Workflow

### Modifying SWF Files

```bash
# 1. Decompile SWF
./temurin-21.jdk/Contents/Home/bin/java -jar FFDec/Contents/Resources/ffdec.jar \
  -export script output_dir/ content/www.poptropica.com/framework.swf

# 2. Edit ActionScript files
vim output_dir/scripts/frame_1/DoAction.as

# 3. Import back into SWF
./temurin-21.jdk/Contents/Home/bin/java -jar FFDec/Contents/Resources/ffdec.jar \
  -replace content/www.poptropica.com/framework.swf script frame_1 output_dir/scripts/frame_1/DoAction.as

# 4. Test
cd electron-pepper && npm start
```

### Creating an Update

```bash
# 1. Make changes to files
vim content/www.poptropica.com/framework.swf
vim electron-pepper/src/main.js

# 2. Create patch update (includes only changed files)
./release-patch.sh 0.1.1 --base 0.1.0

# Important: Always specify --base to include all changes since last release

# 3. Distribute (GitHub Releases or your server)
# Upload: updates/poptropica-patch-0.1.1.zip
```

## Contributing

This is a preservation project for the classic Poptropica game. Contributions welcome!

## License

This project is for educational and preservation purposes.

## Credits

- Original Poptropica game by Poptropica Creators
- Desktop port by the AS2 Desktop Team
- Built with Electron, PepperFlash, and FFDec

## Support

For issues or questions:
- Check the documentation in the `docs/` directory
- Open an issue on GitHub
- See troubleshooting guides in SETUP.md

---

**Note**: This project requires the original Poptropica game assets. Make sure you have the legal right to use them.
