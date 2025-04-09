/**
 * 启动脚本 - 用于启动交易程序并确保正确处理信号
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 日志目录
const LOG_DIR = path.join(__dirname, '../logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 启动日志文件
const startLogFile = path.join(LOG_DIR, `start_${new Date().toISOString().split('T')[0]}.log`);
const logStream = fs.createWriteStream(startLogFile, { flags: 'a' });

// 记录日志的函数
function log(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // 写入日志文件
  logStream.write(logMessage + '\n');
}

// 清理函数
function cleanup() {
  log('正在关闭启动脚本...');
  logStream.end();
}

// 设置信号处理
process.on('SIGINT', () => {
  log('启动脚本收到SIGINT信号');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('启动脚本收到SIGTERM信号');
  cleanup();
  process.exit(0);
});

try {
  log('正在启动交易程序...');
  
  // 启动交易程序
  const tradingProcess = spawn('node', ['src/index.js'], {
    stdio: 'inherit',  // 使用父进程的标准输入输出
    detached: false    // 不分离子进程
  });
  
  // 记录进程ID
  log(`交易程序已启动，PID: ${tradingProcess.pid}`);
  
  // 监听进程退出
  tradingProcess.on('exit', (code, signal) => {
    if (code === 0) {
      log('交易程序正常退出');
    } else {
      log(`交易程序异常退出，退出码: ${code}, 信号: ${signal || 'none'}`);
    }
    
    cleanup();
    process.exit(code || 0);
  });
  
  // 监听进程错误
  tradingProcess.on('error', (err) => {
    log(`启动交易程序出错: ${err.message}`);
    cleanup();
    process.exit(1);
  });
  
  // 将子进程的SIGINT信号传递给父进程
  process.on('SIGINT', () => {
    log('启动脚本收到SIGINT信号，正在传递给交易程序...');
    tradingProcess.kill('SIGINT');
  });
  
  log('启动脚本仍在运行，等待交易程序...');
} catch (error) {
  log(`启动脚本执行错误: ${error.message}`);
  cleanup();
  process.exit(1);
} 