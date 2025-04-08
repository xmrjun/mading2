/**
 * 停止脚本 - 用于发送SIGINT信号关闭所有运行中的交易程序
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 日志目录
const LOG_DIR = path.join(__dirname, '../logs');

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 记录日志的函数
function log(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  
  // 写入日志文件
  const logFile = path.join(LOG_DIR, `stop_${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(
    logFile, 
    logMessage + '\n', 
    { encoding: 'utf8' }
  );
}

try {
  log('尝试查找并停止所有交易程序进程...');
  
  // 查找运行中的node进程
  const grepCommand = process.platform === 'win32' 
    ? `tasklist /FI "IMAGENAME eq node.exe" /FO CSV` 
    : `ps aux | grep "node src/index.js"`;
  
  const processOutput = execSync(grepCommand, { encoding: 'utf8' });
  
  // 查找所有node进程
  const lines = processOutput.split('\n');
  let found = false;
  
  // 遍历每一行，查找交易程序进程
  lines.forEach(line => {
    // 跳过grep命令本身
    if (line.includes('grep') || line.trim() === '') {
      return;
    }
    
    // 检查是否是我们的交易程序
    if (line.includes('src/index.js')) {
      // 提取PID
      const parts = line.split(/\s+/);
      const pid = parts[1]; // PID通常在第二列
      
      if (pid && !isNaN(parseInt(pid))) {
        found = true;
        log(`发现交易程序进程 PID: ${pid}，正在发送关闭信号...`);
        
        try {
          // 发送SIGINT信号
          const killCommand = process.platform === 'win32'
            ? `taskkill /PID ${pid} /F`
            : `kill -2 ${pid}`; // SIGINT = -2
          
          execSync(killCommand);
          log(`已成功向进程 ${pid} 发送关闭信号`);
        } catch (killError) {
          log(`向进程 ${pid} 发送关闭信号失败: ${killError.message}`);
          
          // 尝试强制终止
          try {
            const forceKillCommand = process.platform === 'win32'
              ? `taskkill /PID ${pid} /F`
              : `kill -9 ${pid}`;
            
            execSync(forceKillCommand);
            log(`已强制终止进程 ${pid}`);
          } catch (forceKillError) {
            log(`强制终止进程 ${pid} 失败: ${forceKillError.message}`);
          }
        }
      }
    }
  });
  
  if (!found) {
    log('未找到运行中的交易程序进程');
  } else {
    // 等待一段时间，确保进程有时间正常关闭
    log('等待进程完全停止...');
    setTimeout(() => {
      log('停止脚本执行完毕');
    }, 2000);
  }
} catch (error) {
  log(`停止脚本执行错误: ${error.message}`);
  process.exit(1);
} 