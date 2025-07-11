const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');

/**
 * 基于日志的统计服务
 * 核心思想：本地日志是最可靠的数据源，完全不依赖API余额查询
 */
class LogBasedStatsService {
  /**
   * 构造函数
   * @param {Object} tradeStats - 交易统计实例
   * @param {Object} config - 配置对象
   * @param {Object} logger - 日志记录器
   */
  constructor(tradeStats, config, logger) {
    this.tradeStats = tradeStats;
    this.config = config;
    this.logger = logger || console;
    this.tradingCoin = config.trading?.tradingCoin || 'BTC';
    this.logDir = path.join(process.cwd(), 'logs');
  }

  /**
   * 写入结构化交易日志
   * @param {string} action - 操作类型: 'BUY_ORDER_CREATED', 'BUY_ORDER_FILLED', 'SELL_ORDER_CREATED', 'SELL_ORDER_FILLED'
   * @param {Object} data - 交易数据
   */
  writeTradeLog(action, data) {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        action,
        tradingCoin: this.tradingCoin,
        ...data
      };

      // 写入结构化交易日志
      const tradeLogFile = path.join(this.logDir, `trades_${this.getDateString()}.json`);
      const logLine = JSON.stringify(logEntry) + '\n';
      
      fs.appendFileSync(tradeLogFile, logLine, { encoding: 'utf8' });
      
      // 同时写入可读格式的日志
      const readableMsg = this.formatTradeMessage(action, data);
      log(`📝 [交易日志] ${readableMsg}`);
      
    } catch (error) {
      log(`写入交易日志失败: ${error.message}`, true);
    }
  }

  /**
   * 格式化交易消息
   */
  formatTradeMessage(action, data) {
    switch (action) {
      case 'BUY_ORDER_CREATED':
        return `买单创建: ${data.orderId} - ${data.quantity} ${this.tradingCoin} @ ${data.price} USDC`;
      case 'BUY_ORDER_FILLED':
        return `买单成交: ${data.orderId} - ${data.filledQuantity} ${this.tradingCoin} @ ${data.avgPrice} USDC (总价值: ${data.filledAmount} USDC)`;
      case 'BUY_PARTIAL_FILLED':
        return `买单部分成交: ${data.orderId} - 新增 ${data.newFilledQuantity} ${this.tradingCoin}`;
      case 'SELL_ORDER_CREATED':
        return `卖单创建: ${data.orderId} - ${data.quantity} ${this.tradingCoin} @ ${data.price} USDC`;
      case 'SELL_ORDER_FILLED':
        return `卖单成交: ${data.orderId} - ${data.filledQuantity} ${this.tradingCoin} @ ${data.avgPrice} USDC`;
      case 'STATS_UPDATED':
        return `统计更新: 持仓 ${data.totalQuantity} ${this.tradingCoin}, 平均价 ${data.averagePrice} USDC, 订单数 ${data.orderCount}`;
      default:
        return `${action}: ${JSON.stringify(data)}`;
    }
  }

  /**
   * 从日志恢复统计数据
   * @returns {Promise<Object>} 恢复结果
   */
  async recoverStatsFromLogs() {
    try {
      log('🔄 开始从本地日志恢复交易统计...');
      
      // 1. 读取所有交易日志文件
      const tradeLogFiles = this.getTradeLogFiles();
      
      if (tradeLogFiles.length === 0) {
        log('📋 未找到交易日志文件，从零开始');
        return { success: true, recovered: false, message: '无历史交易记录' };
      }

      log(`📁 找到 ${tradeLogFiles.length} 个交易日志文件`);

      // 2. 解析所有交易记录
      const allTrades = await this.parseTradeLogFiles(tradeLogFiles);
      
      if (allTrades.length === 0) {
        log('📋 交易日志为空，从零开始');
        return { success: true, recovered: false, message: '交易日志为空' };
      }

      log(`📊 解析出 ${allTrades.length} 条交易记录`);

      // 3. 重建统计数据
      const recoveredStats = this.rebuildStatsFromTrades(allTrades);

      // 4. 应用到当前统计实例
      this.applyRecoveredStats(recoveredStats);

      log('✅ 统计数据恢复完成');
      log(`📊 恢复结果:`);
      log(`   总持仓: ${recoveredStats.totalQuantity.toFixed(6)} ${this.tradingCoin}`);
      log(`   总成本: ${recoveredStats.totalAmount.toFixed(2)} USDC`);
      log(`   平均价: ${recoveredStats.averagePrice.toFixed(2)} USDC`);
      log(`   订单数: ${recoveredStats.orderCount}`);

      return {
        success: true,
        recovered: true,
        stats: recoveredStats,
        tradeCount: allTrades.length
      };

    } catch (error) {
      log(`从日志恢复统计失败: ${error.message}`, true);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取所有交易日志文件
   */
  getTradeLogFiles() {
    try {
      if (!fs.existsSync(this.logDir)) {
        return [];
      }

      const files = fs.readdirSync(this.logDir);
      const tradeLogFiles = files
        .filter(file => file.startsWith('trades_') && file.endsWith('.json'))
        .map(file => path.join(this.logDir, file))
        .sort(); // 按时间顺序排序

      return tradeLogFiles;
    } catch (error) {
      log(`读取日志目录失败: ${error.message}`, true);
      return [];
    }
  }

  /**
   * 解析交易日志文件
   */
  async parseTradeLogFiles(logFiles) {
    const allTrades = [];
    
    for (const logFile of logFiles) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.trim().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const trade = JSON.parse(line);
            if (trade.tradingCoin === this.tradingCoin) {
              allTrades.push(trade);
            }
          } catch (parseError) {
            log(`解析交易记录失败: ${parseError.message}`, true);
          }
        }
      } catch (error) {
        log(`读取日志文件失败 ${logFile}: ${error.message}`, true);
      }
    }

    // 按时间排序
    allTrades.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    return allTrades;
  }

  /**
   * 从交易记录重建统计数据
   */
  rebuildStatsFromTrades(trades) {
    const stats = {
      totalQuantity: 0,
      totalAmount: 0,
      averagePrice: 0,
      orderCount: 0,
      lastUpdateTime: null
    };

    const processedOrders = new Set();

    for (const trade of trades) {
      try {
        switch (trade.action) {
          case 'BUY_ORDER_FILLED':
            if (!processedOrders.has(trade.orderId)) {
              stats.totalQuantity += parseFloat(trade.filledQuantity || 0);
              stats.totalAmount += parseFloat(trade.filledAmount || 0);
              stats.orderCount += 1;
              processedOrders.add(trade.orderId);
              stats.lastUpdateTime = trade.timestamp;
            }
            break;
            
          case 'BUY_PARTIAL_FILLED':
            // 部分成交增量更新
            stats.totalQuantity += parseFloat(trade.newFilledQuantity || 0);
            stats.totalAmount += parseFloat(trade.newFilledAmount || 0);
            stats.lastUpdateTime = trade.timestamp;
            break;
            
          case 'SELL_ORDER_FILLED':
            // 卖出操作减少持仓
            stats.totalQuantity -= parseFloat(trade.filledQuantity || 0);
            // 注意：卖出不减少成本，只减少数量
            stats.lastUpdateTime = trade.timestamp;
            break;
        }
      } catch (error) {
        log(`处理交易记录失败: ${error.message}`, true);
      }
    }

    // 计算平均价
    if (stats.totalQuantity > 0 && stats.totalAmount > 0) {
      stats.averagePrice = stats.totalAmount / stats.totalQuantity;
    }

    return stats;
  }

  /**
   * 应用恢复的统计数据
   */
  applyRecoveredStats(recoveredStats) {
    this.tradeStats.totalFilledQuantity = recoveredStats.totalQuantity;
    this.tradeStats.totalFilledAmount = recoveredStats.totalAmount;
    this.tradeStats.averagePrice = recoveredStats.averagePrice;
    this.tradeStats.filledOrders = recoveredStats.orderCount;
    this.tradeStats.lastUpdateTime = recoveredStats.lastUpdateTime ? new Date(recoveredStats.lastUpdateTime) : new Date();
  }

  /**
   * 记录买单创建
   */
  logBuyOrderCreated(orderId, price, quantity) {
    this.writeTradeLog('BUY_ORDER_CREATED', {
      orderId,
      price: parseFloat(price),
      quantity: parseFloat(quantity)
    });
  }

  /**
   * 记录买单成交
   */
  logBuyOrderFilled(orderId, filledQuantity, filledAmount, avgPrice) {
    this.writeTradeLog('BUY_ORDER_FILLED', {
      orderId,
      filledQuantity: parseFloat(filledQuantity),
      filledAmount: parseFloat(filledAmount),
      avgPrice: parseFloat(avgPrice)
    });
  }

  /**
   * 记录买单部分成交
   */
  logBuyPartialFilled(orderId, newFilledQuantity, newFilledAmount) {
    this.writeTradeLog('BUY_PARTIAL_FILLED', {
      orderId,
      newFilledQuantity: parseFloat(newFilledQuantity),
      newFilledAmount: parseFloat(newFilledAmount)
    });
  }

  /**
   * 记录卖单成交
   */
  logSellOrderFilled(orderId, filledQuantity, filledAmount, avgPrice) {
    this.writeTradeLog('SELL_ORDER_FILLED', {
      orderId,
      filledQuantity: parseFloat(filledQuantity),
      filledAmount: parseFloat(filledAmount),
      avgPrice: parseFloat(avgPrice)
    });
  }

  /**
   * 记录统计更新
   */
  logStatsUpdated() {
    this.writeTradeLog('STATS_UPDATED', {
      totalQuantity: this.tradeStats.totalFilledQuantity,
      averagePrice: this.tradeStats.averagePrice,
      orderCount: this.tradeStats.filledOrders
    });
  }

  /**
   * 获取日期字符串
   */
  getDateString() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 清理旧日志文件（保留最近30天）
   */
  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir);
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      files.forEach(file => {
        if (file.startsWith('trades_') && file.endsWith('.json')) {
          const filePath = path.join(this.logDir, file);
          const stats = fs.statSync(filePath);
          if (stats.mtime < thirtyDaysAgo) {
            fs.unlinkSync(filePath);
            log(`已清理旧交易日志: ${file}`);
          }
        }
      });
    } catch (error) {
      log(`清理旧日志失败: ${error.message}`, true);
    }
  }
}

module.exports = LogBasedStatsService;