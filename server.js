const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'my-super-secret-key-2025';
const SERVERS_BASE_PATH = process.env.SERVERS_PATH || '/tmp/servers';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Session management for terminal contexts
const terminalSessions = new Map();

// Authentication middleware
const authenticateAPI = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    return res.status(403).json({ 
      success: false, 
      message: 'Forbidden: Invalid API Key' 
    });
  }
  next();
};

app.use(authenticateAPI);

// Utility functions
const getServerPath = (serverId) => {
  return path.join(SERVERS_BASE_PATH, serverId);
};

const checkServerStatus = async (serverId, serverPath) => {
  try {
    // Check if there's a running process for this server
    const result = await executeCommand(`pgrep -f "${serverId}"`);
    const hasRunningProcess = result.stdout.trim().length > 0;
    
    // Check for common server files and ports
    const checks = await Promise.all([
      fs.access(path.join(serverPath, 'package.json')).then(() => true).catch(() => false),
      fs.access(path.join(serverPath, 'index.js')).then(() => true).catch(() => false),
      fs.access(path.join(serverPath, 'main.py')).then(() => true).catch(() => false),
      fs.access(path.join(serverPath, 'app.js')).then(() => true).catch(() => false),
    ]);
    
    const hasServerFiles = checks.some(check => check);
    
    if (hasRunningProcess) {
      return 'running';
    } else if (hasServerFiles) {
      return 'stopped';
    } else {
      return 'inactive';
    }
  } catch (error) {
    return 'unknown';
  }
};

const ensureServerDirectory = async (serverId) => {
  const serverPath = getServerPath(serverId);
  try {
    await fs.access(serverPath);
  } catch (error) {
    await fs.mkdir(serverPath, { recursive: true });
  }
  return serverPath;
};

const executeCommand = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    exec(command, { 
      timeout: 30000, 
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
      ...options 
    }, (error, stdout, stderr) => {
      resolve({ 
        success: !error || (stdout || stderr),
        stdout: stdout || '', 
        stderr: stderr || '', 
        error: error ? error.message : null
      });
    });
  });
};

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ===== TERMINAL MANAGEMENT =====

// Execute command in terminal
app.post('/servers/:serverId/execute', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { command, cwd = '.' } = req.body;
    
    if (!command) {
      return res.status(400).json({ 
        success: false, 
        message: 'Command is required' 
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const sessionKey = `${serverId}`;
    
    // Get current working directory from session
    let currentSession = terminalSessions.get(sessionKey) || { cwd: serverPath };
    let workingDir = path.resolve(currentSession.cwd, cwd);

    // Handle cd commands specially
    if (command.trim().startsWith('cd ')) {
      const targetDir = command.trim().substring(3).trim() || '~';
      
      if (targetDir === '~') {
        workingDir = serverPath;
      } else if (targetDir === '..') {
        workingDir = path.dirname(workingDir);
      } else if (path.isAbsolute(targetDir)) {
        workingDir = targetDir;
      } else {
        workingDir = path.resolve(workingDir, targetDir);
      }

      // Verify directory exists
      try {
        const stats = await fs.stat(workingDir);
        if (!stats.isDirectory()) {
          return res.json({
            success: false,
            stdout: '',
            stderr: `cd: not a directory: ${targetDir}`,
            cwd: currentSession.cwd
          });
        }
      } catch (error) {
        return res.json({
          success: false,
          stdout: '',
          stderr: `cd: no such file or directory: ${targetDir}`,
          cwd: currentSession.cwd
        });
      }

      // Update session
      terminalSessions.set(sessionKey, { cwd: workingDir });
      
      return res.json({
        success: true,
        stdout: '',
        stderr: '',
        cwd: workingDir
      });
    }

    // Execute regular command
    const result = await executeCommand(command, { cwd: workingDir });
    
    // Update session with current directory
    terminalSessions.set(sessionKey, { cwd: workingDir });

    res.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      cwd: workingDir,
      error: result.error
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Get terminal session info
app.get('/servers/:serverId/terminal/session', (req, res) => {
  const { serverId } = req.params;
  const sessionKey = `${serverId}`;
  const session = terminalSessions.get(sessionKey) || { 
    cwd: getServerPath(serverId) 
  };
  
  res.json(session);
});

// ===== FILE MANAGEMENT =====

// List files and directories
app.get('/servers/:serverId/files', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { path: requestPath = '.' } = req.query;
    
    const serverPath = await ensureServerDirectory(serverId);
    const fullPath = path.resolve(serverPath, requestPath);
    
    // Security check - ensure we're not accessing outside server directory
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied: Path outside server directory' 
      });
    }

    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const files = [];

    for (const item of items) {
      const itemPath = path.join(fullPath, item.name);
      const stats = await fs.stat(itemPath);
      
      files.push({
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        size: stats.size,
        modified: stats.mtime.toISOString(),
        path: path.relative(serverPath, itemPath)
      });
    }

    res.json({
      success: true,
      files: files.sort((a, b) => {
        // Directories first, then files
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      }),
      currentPath: path.relative(serverPath, fullPath) || '.'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to list files',
      error: error.message
    });
  }
});

// Read file content
app.get('/servers/:serverId/files/content', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { path: requestPath } = req.query;
    
    if (!requestPath) {
      return res.status(400).json({ 
        success: false, 
        message: 'Path is required' 
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const fullPath = path.resolve(serverPath, requestPath);
    
    // Security check
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const stats = await fs.stat(fullPath);
    
    res.json({
      success: true,
      content,
      size: stats.size,
      modified: stats.mtime.toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to read file',
      error: error.message
    });
  }
});

// Create or update file
app.post('/servers/:serverId/files', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { path: requestPath, content, createDirectories = false } = req.body;
    
    if (!requestPath) {
      return res.status(400).json({ 
        success: false, 
        message: 'Path is required' 
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const fullPath = path.resolve(serverPath, requestPath);
    
    // Security check
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    // Create directories if needed
    if (createDirectories) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
    }

    await fs.writeFile(fullPath, content || '', 'utf8');
    const stats = await fs.stat(fullPath);
    
    res.json({
      success: true,
      message: 'File saved successfully',
      size: stats.size,
      modified: stats.mtime.toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to save file',
      error: error.message
    });
  }
});

// Delete file or directory
app.delete('/servers/:serverId/files', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { path: requestPath } = req.query;
    
    if (!requestPath) {
      return res.status(400).json({ 
        success: false, 
        message: 'Path is required' 
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const fullPath = path.resolve(serverPath, requestPath);
    
    // Security check
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const stats = await fs.stat(fullPath);
    
    if (stats.isDirectory()) {
      await fs.rmdir(fullPath, { recursive: true });
    } else {
      await fs.unlink(fullPath);
    }
    
    res.json({
      success: true,
      message: `${stats.isDirectory() ? 'Directory' : 'File'} deleted successfully`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete',
      error: error.message
    });
  }
});

// Create directory
app.post('/servers/:serverId/directories', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { path: requestPath } = req.body;
    
    if (!requestPath) {
      return res.status(400).json({ 
        success: false, 
        message: 'Path is required' 
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const fullPath = path.resolve(serverPath, requestPath);
    
    // Security check
    if (!fullPath.startsWith(serverPath)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    await fs.mkdir(fullPath, { recursive: true });
    
    res.json({
      success: true,
      message: 'Directory created successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create directory',
      error: error.message
    });
  }
});

// Upload files to server
app.post('/servers/:serverId/upload', upload.array('files'), async (req, res) => {
  try {
    const { serverId } = req.params;
    const { targetPath = '.' } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const serverPath = await ensureServerDirectory(serverId);
    const targetDir = path.resolve(serverPath, targetPath);

    // Security check
    if (!targetDir.startsWith(serverPath)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const uploadedFiles = [];

    for (const file of files) {
      const filePath = path.join(targetDir, file.originalname);
      
      // Handle ZIP files - extract them
      if (file.originalname.endsWith('.zip')) {
        try {
          const zip = new AdmZip(file.buffer);
          const extractPath = path.join(targetDir, path.parse(file.originalname).name);
          
          // Create extraction directory
          await fs.mkdir(extractPath, { recursive: true });
          
          // Extract files
          zip.extractAllTo(extractPath, true);
          
          uploadedFiles.push({
            name: file.originalname,
            type: 'archive',
            extracted: true,
            extractPath: path.relative(serverPath, extractPath),
            size: file.size
          });
        } catch (error) {
          uploadedFiles.push({
            name: file.originalname,
            type: 'file',
            error: 'Failed to extract ZIP: ' + error.message,
            size: file.size
          });
        }
      } else {
        // Regular file upload
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.buffer);
        
        uploadedFiles.push({
          name: file.originalname,
          type: 'file',
          path: path.relative(serverPath, filePath),
          size: file.size
        });
      }
    }

    res.json({
      success: true,
      message: `Uploaded ${files.length} file(s)`,
      files: uploadedFiles
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Upload failed',
      error: error.message
    });
  }
});

// ===== SERVER MANAGEMENT =====

// List all servers
app.get('/servers', async (req, res) => {
  try {
    await fs.mkdir(SERVERS_BASE_PATH, { recursive: true });
    const items = await fs.readdir(SERVERS_BASE_PATH, { withFileTypes: true });
    
    const servers = [];
    for (const item of items) {
      if (item.isDirectory()) {
        const serverPath = path.join(SERVERS_BASE_PATH, item.name);
        const stats = await fs.stat(serverPath);
        const status = await checkServerStatus(item.name, serverPath);
        
        servers.push({
          id: item.name,
          name: item.name,
          path: serverPath,
          status,
          created: stats.birthtime.toISOString()
        });
      }
    }

    res.json({
      success: true,
      servers
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to list servers',
      error: error.message
    });
  }
});

// Create new server
app.post('/servers', async (req, res) => {
  try {
    const { name, template = 'basic' } = req.body;
    
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Server name is required' 
      });
    }

    const serverId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const serverPath = await ensureServerDirectory(serverId);
    
    // Create basic structure based on template
    if (template === 'nodejs') {
      await fs.writeFile(
        path.join(serverPath, 'package.json'),
        JSON.stringify({
          name: serverId,
          version: '1.0.0',
          main: 'index.js',
          scripts: {
            start: 'node index.js'
          }
        }, null, 2)
      );
      await fs.writeFile(
        path.join(serverPath, 'index.js'),
        '// Welcome to your new Node.js server!\nconsole.log("Hello World!");\n'
      );
    } else if (template === 'python') {
      await fs.writeFile(
        path.join(serverPath, 'main.py'),
        '# Welcome to your new Python server!\nprint("Hello World!")\n'
      );
      await fs.writeFile(
        path.join(serverPath, 'requirements.txt'),
        '# Add your Python dependencies here\n'
      );
    } else {
      // Basic template
      await fs.writeFile(
        path.join(serverPath, 'README.md'),
        `# ${name}\n\nWelcome to your new server!\n`
      );
    }

    res.json({
      success: true,
      message: 'Server created successfully',
      server: {
        id: serverId,
        name,
        path: serverPath,
        template
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create server',
      error: error.message
    });
  }
});

// Delete server
app.delete('/servers/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    const serverPath = getServerPath(serverId);
    
    // Remove from terminal sessions
    terminalSessions.delete(serverId);
    
    // Delete directory
    await fs.rmdir(serverPath, { recursive: true });
    
    res.json({
      success: true,
      message: 'Server deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete server',
      error: error.message
    });
  }
});

// Server actions (start/stop/restart)
app.post('/servers/:serverId/actions', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { action, command } = req.body;
    
    const serverPath = getServerPath(serverId);
    
    let result;
    
    switch (action) {
      case 'start':
        result = await executeCommand(command || 'npm start', { cwd: serverPath });
        break;
      case 'stop':
        result = await executeCommand('pkill -f ' + serverId, { cwd: serverPath });
        break;
      case 'restart':
        await executeCommand('pkill -f ' + serverId, { cwd: serverPath });
        result = await executeCommand(command || 'npm start', { cwd: serverPath });
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid action. Use: start, stop, or restart'
        });
    }

    res.json({
      success: result.success,
      message: `Server ${action} ${result.success ? 'successful' : 'failed'}`,
      output: result.stdout,
      error: result.stderr
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to execute action',
      error: error.message
    });
  }
});

// Get server logs
app.get('/servers/:serverId/logs', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { lines = 100 } = req.query;
    
    // Try to get logs from different sources
    const logSources = [
      path.join(getServerPath(serverId), 'logs', 'app.log'),
      path.join(getServerPath(serverId), 'server.log'),
      path.join(getServerPath(serverId), 'output.log')
    ];
    
    let logs = '';
    for (const logFile of logSources) {
      try {
        const logContent = await fs.readFile(logFile, 'utf8');
        logs += `=== ${path.basename(logFile)} ===\n${logContent}\n\n`;
      } catch (error) {
        // File doesn't exist, continue
      }
    }
    
    if (!logs) {
      // If no log files, try to get recent output from system logs
      const result = await executeCommand(`journalctl -u ${serverId} -n ${lines} --no-pager`);
      logs = result.stdout || 'No logs available';
    }
    
    res.json({
      success: true,
      logs: logs.split('\n').slice(-lines).join('\n')
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get logs',
      error: error.message
    });
  }
});

// Get running processes for server
app.get('/servers/:serverId/processes', async (req, res) => {
  try {
    const { serverId } = req.params;
    const result = await executeCommand(`ps aux | grep "${serverId}" | grep -v grep`);
    
    const processes = result.stdout.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parts[1],
          cpu: parts[2],
          memory: parts[3],
          command: parts.slice(10).join(' ')
        };
      });

    res.json({
      success: true,
      processes
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get processes',
      error: error.message
    });
  }
});

// ===== SYSTEM INFORMATION =====

// Get system information
app.get('/system/info', async (req, res) => {
  try {
    const [cpuInfo, memInfo, diskInfo] = await Promise.all([
      executeCommand('cat /proc/cpuinfo | grep "model name" | head -1'),
      executeCommand('free -h'),
      executeCommand('df -h /')
    ]);

    res.json({
      success: true,
      system: {
        cpu: cpuInfo.stdout.split(':')[1]?.trim() || 'Unknown',
        memory: memInfo.stdout,
        disk: diskInfo.stdout,
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get system info',
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server Bridge running on port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`📁 Servers path: ${path.resolve(SERVERS_BASE_PATH)}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   POST /servers/:id/execute - Execute terminal commands`);
  console.log(`   GET  /servers/:id/files - List files`);
  console.log(`   POST /servers/:id/files - Create/update files`);
  console.log(`   GET  /servers - List all servers`);
  console.log(`   POST /servers - Create new server`);
  console.log(`   GET  /system/info - System information`);
  console.log(`\n🌐 Ready to receive webhooks!`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Gracefully shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Gracefully shutting down...');
  process.exit(0);
});