const fs = require('fs');
const path = require('path');
const MartingaleStrategy = require('./src/core/martingaleStrategy');
const BackpackService = require('./src/services/backpackService');
const PriceMonitor = require('./src/core/priceMonitor');
const { log, Logger } = require('./src/utils/logger');

/**
 * 马丁格尔交易应用主类
 */
class MartingaleTrader {
  constructor(configPath = 'martingale_config.json') {
    // 加载配置
    this.config = this.loadConfig(configPath);
    
    // 初始化日志系统
    this.logger = new Logger({
      logDir: path.join(__dirname, 'logs'),
      prefix: 'martingale'
    });
    
    // 初始化服务
    this.backpackService = new BackpackService(this.config, this.logger);
    this.martingaleStrategy = new MartingaleStrategy(this.config, this.logger);
    
    // 初始化价格监控
    this.priceMonitor = new PriceMonitor({
      config: this.config,
      onPriceUpdate: this.handlePriceUpdate.bind(this),
      logger: this.logger
    });
    
    // 应用状态
    this.isRunning = false;
    this.currentPrice = null;
    this.lastOrderTime = null;
    this.pendingOrders = new Map();
    this.position = { quantity: 0, averagePrice: 0 };
    
    // 定时器
    this.monitorInterval = null;
    this.orderCheckInterval = null;
    
    log('🎲 马丁格尔交易应用初始化完成');
  }

  /**
   * 加载配置文件
   */
  loadConfig(configPath) {
    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`配置文件不存在: ${configPath}`);
      }
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      log(`✅ 已加载配置文件: ${configPath}`);
      return config;
    } catch (error) {
      log(`❌ 加载配置文件失败: ${error.message}`, true);
      process.exit(1);
    }
  }

  /**
   * 启动马丁格尔交易
   */
  async start() {
    try {
      if (this.isRunning) {
        log('⚠️ 马丁格尔交易器已在运行中');
        return;
      }

      log('🚀 启动马丁格尔交易器...');
      
      // 验证API连接
      await this.validateApiConnection();
      
      // 获取初始持仓
      await this.updatePosition();
      
      // 启动策略
      this.martingaleStrategy.start();
      
      // 启动价格监控
      await this.priceMonitor.start();
      
      // 启动定时任务
      this.startMonitoring();
      
      this.isRunning = true;
      log('✅ 马丁格尔交易器启动成功');
      
      // 显示初始状态
      this.displayStatus();
      
    } catch (error) {
      log(`❌ 启动失败: ${error.message}`, true);
      await this.stop();
    }
  }

  /**
   * 停止马丁格尔交易
   */
  async stop() {
    log('⏹️ 停止马丁格尔交易器...');
    
    this.isRunning = false;
    
    // 停止策略
    this.martingaleStrategy.stop();
    
    // 停止价格监控
    if (this.priceMonitor) {
      await this.priceMonitor.stop();
    }
    
    // 清除定时器
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    if (this.orderCheckInterval) {
      clearInterval(this.orderCheckInterval);
    }
    
    log('✅ 马丁格尔交易器已停止');
  }

  /**
   * 验证API连接
   */
  async validateApiConnection() {
    try {
      log('🔐 验证API连接...');
      const balances = await this.backpackService.getBalances();
      if (!balances) {
        throw new Error('无法获取账户余额');
      }
      log('✅ API连接正常');
    } catch (error) {
      throw new Error(`API连接失败: ${error.message}`);
    }
  }

  /**
   * 更新持仓信息
   */
  async updatePosition() {
    try {
      const position = await this.backpackService.getPosition(this.config.trading.tradingCoin);
      
      this.position = {
        quantity: parseFloat(position.available || 0),
        total: parseFloat(position.total || 0)
      };
      
      // 如果有持仓，需要计算平均价格
      if (this.position.quantity > 0) {
        await this.calculateAveragePrice();
      }
      
      // 更新策略持仓信息
      this.martingaleStrategy.setPosition(this.position);
      
      log(`💼 当前持仓: ${this.position.quantity.toFixed(6)} ${this.config.trading.tradingCoin}`);
      
    } catch (error) {
      log(`❌ 更新持仓失败: ${error.message}`, true);
    }
  }

  /**
   * 计算平均价格 (简化版本，实际应该从交易历史计算)
   */
  async calculateAveragePrice() {
    try {
      // 这里应该从交易历史计算真实的平均价格
      // 现在使用当前市场价作为估算
      const ticker = await this.backpackService.getTicker(`${this.config.trading.tradingCoin}_USDC`);
      if (ticker && ticker.lastPrice) {
        this.position.averagePrice = parseFloat(ticker.lastPrice);
        log(`📊 估算持仓均价: ${this.position.averagePrice.toFixed(2)} USDC`);
      }
    } catch (error) {
      log(`⚠️ 无法获取价格信息: ${error.message}`);
    }
  }

  /**
   * 处理价格更新
   */
  async handlePriceUpdate(priceInfo) {
    this.currentPrice = priceInfo.price;
    
    if (!this.isRunning) return;
    
    try {
      // 检查止盈条件
      if (this.position.quantity > 0 && this.position.averagePrice > 0) {
        if (this.martingaleStrategy.shouldTakeProfit(this.currentPrice, this.position.averagePrice)) {
          await this.executeTakeProfit();
          return;
        }
        
        // 检查止损条件
        if (this.martingaleStrategy.shouldStopLoss(this.currentPrice, this.position.averagePrice)) {
          await this.executeStopLoss();
          return;
        }
      }
      
      // 如果没有持仓或已止盈，考虑新的买入
      if (this.position.quantity === 0) {
        await this.considerNewBuy();
      }
      
    } catch (error) {
      log(`❌ 处理价格更新时出错: ${error.message}`, true);
    }
  }

  /**
   * 考虑新的买入机会
   */
  async considerNewBuy() {
    try {
      // 检查是否可以创建新订单
      if (this.pendingOrders.size > 0) {
        return; // 有待处理订单，等待
      }
      
      // 检查时间间隔 (避免频繁交易)
      const minInterval = 60000; // 1分钟
      if (this.lastOrderTime && (Date.now() - this.lastOrderTime) < minInterval) {
        return;
      }
      
      // 创建买入订单
      const order = this.martingaleStrategy.createBuyOrder(
        this.currentPrice,
        this.config.trading.symbol,
        this.config.trading.tradingCoin
      );
      
      if (order) {
        await this.submitOrder(order);
      }
      
    } catch (error) {
      log(`❌ 考虑买入时出错: ${error.message}`, true);
    }
  }

  /**
   * 执行止盈
   */
  async executeTakeProfit() {
    try {
      log('🎯 执行止盈操作...');
      
      const order = this.martingaleStrategy.createSellOrder(
        this.currentPrice,
        this.position.averagePrice,
        this.position.quantity,
        this.config.trading.symbol,
        this.config.trading.tradingCoin
      );
      
      if (order) {
        await this.submitOrder(order);
        
        // 计算盈利
        const profit = (this.currentPrice - this.position.averagePrice) * this.position.quantity;
        this.martingaleStrategy.processTradeResult('win', profit);
        
        // 重置持仓
        this.position = { quantity: 0, averagePrice: 0 };
      }
      
    } catch (error) {
      log(`❌ 执行止盈时出错: ${error.message}`, true);
    }
  }

  /**
   * 执行止损
   */
  async executeStopLoss() {
    try {
      log('⛔ 执行止损操作...');
      
      const order = this.martingaleStrategy.createSellOrder(
        this.currentPrice,
        this.position.averagePrice,
        this.position.quantity,
        this.config.trading.symbol,
        this.config.trading.tradingCoin
      );
      
      if (order) {
        await this.submitOrder(order);
        
        // 计算亏损
        const loss = (this.position.averagePrice - this.currentPrice) * this.position.quantity;
        this.martingaleStrategy.processTradeResult('loss', -loss);
        
        // 重置持仓
        this.position = { quantity: 0, averagePrice: 0 };
      }
      
    } catch (error) {
      log(`❌ 执行止损时出错: ${error.message}`, true);
    }
  }

  /**
   * 提交订单
   */
  async submitOrder(order) {
    try {
      log(`📤 提交订单: ${order.side} ${order.quantity.toFixed(6)} ${this.config.trading.tradingCoin} @ ${order.price.toFixed(2)}`);
      
      const result = await this.backpackService.createOrder(order);
      
      if (result && result.id) {
        this.pendingOrders.set(result.id, {
          ...order,
          id: result.id,
          timestamp: new Date()
        });
        
        this.lastOrderTime = Date.now();
        log(`✅ 订单提交成功: ${result.id}`);
      } else {
        log(`❌ 订单提交失败`);
      }
      
    } catch (error) {
      log(`❌ 提交订单时出错: ${error.message}`, true);
    }
  }

  /**
   * 开始监控任务
   */
  startMonitoring() {
    // 订单状态检查
    this.orderCheckInterval = setInterval(async () => {
      await this.checkPendingOrders();
    }, this.config.advanced.checkOrdersIntervalMinutes * 60 * 1000);
    
    // 定期状态显示
    this.monitorInterval = setInterval(() => {
      this.displayStatus();
    }, this.config.logging.statisticsInterval * 1000);
  }

  /**
   * 检查待处理订单
   */
  async checkPendingOrders() {
    for (const [orderId, orderInfo] of this.pendingOrders.entries()) {
      try {
        const orderStatus = await this.backpackService.getOrderStatus(orderId);
        
        if (orderStatus.status === 'Filled') {
          // 订单成交
          await this.handleOrderFilled(orderId, orderInfo, orderStatus);
        } else if (orderStatus.status === 'Cancelled' || orderStatus.status === 'Rejected') {
          // 订单取消或拒绝
          this.pendingOrders.delete(orderId);
          log(`⚠️ 订单 ${orderId} 状态: ${orderStatus.status}`);
        }
        
      } catch (error) {
        log(`❌ 检查订单 ${orderId} 状态时出错: ${error.message}`);
      }
    }
  }

  /**
   * 处理订单成交
   */
  async handleOrderFilled(orderId, orderInfo, orderStatus) {
    this.pendingOrders.delete(orderId);
    
    if (orderInfo.side === 'Bid') {
      // 买入成交 - 更新持仓
      const filledQuantity = parseFloat(orderStatus.filledQuantity || orderInfo.quantity);
      const filledPrice = parseFloat(orderStatus.avgPrice || orderInfo.price);
      
      // 更新持仓均价
      if (this.position.quantity > 0) {
        const totalCost = (this.position.quantity * this.position.averagePrice) + (filledQuantity * filledPrice);
        const totalQuantity = this.position.quantity + filledQuantity;
        this.position.averagePrice = totalCost / totalQuantity;
      } else {
        this.position.averagePrice = filledPrice;
      }
      
      this.position.quantity += filledQuantity;
      
      log(`✅ 买入成交: ${filledQuantity.toFixed(6)} ${this.config.trading.tradingCoin} @ ${filledPrice.toFixed(2)}`);
      log(`📊 新持仓: ${this.position.quantity.toFixed(6)} @ ${this.position.averagePrice.toFixed(2)}`);
      
    } else if (orderInfo.side === 'Ask') {
      // 卖出成交 - 已在 executeTakeProfit/executeStopLoss 中处理
      log(`✅ 卖出成交: ${orderInfo.quantity.toFixed(6)} ${this.config.trading.tradingCoin} @ ${orderInfo.price.toFixed(2)}`);
    }
    
    // 更新策略持仓信息
    this.martingaleStrategy.setPosition(this.position);
  }

  /**
   * 显示当前状态
   */
  displayStatus() {
    const strategyStatus = this.martingaleStrategy.getStatus();
    const riskAssessment = this.martingaleStrategy.getRiskAssessment();
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 马丁格尔交易器状态');
    console.log('='.repeat(60));
    console.log(`🔄 运行状态: ${this.isRunning ? '运行中' : '已停止'}`);
    console.log(`💰 当前价格: ${this.currentPrice ? this.currentPrice.toFixed(2) : 'N/A'} USDC`);
    console.log(`💼 持仓数量: ${this.position.quantity.toFixed(6)} ${this.config.trading.tradingCoin}`);
    console.log(`📈 持仓均价: ${this.position.averagePrice ? this.position.averagePrice.toFixed(2) : 'N/A'} USDC`);
    console.log(`📋 待处理订单: ${this.pendingOrders.size} 笔`);
    console.log('');
    console.log('🎲 马丁格尔策略状态:');
    console.log(`   策略状态: ${strategyStatus.isRunning ? '运行中' : '已停止'}`);
    console.log(`   连续亏损: ${strategyStatus.consecutiveLosses}/${strategyStatus.maxLosses}`);
    console.log(`   当前Level: ${strategyStatus.consecutiveLosses}`);
    console.log(`   下次金额: ${riskAssessment.nextTradeAmount.toFixed(2)} USDC`);
    console.log(`   风险等级: ${riskAssessment.riskCategory} (${(riskAssessment.riskLevel * 100).toFixed(1)}%)`);
    console.log(`   总交易数: ${strategyStatus.totalTrades} 笔`);
    console.log('='.repeat(60));
  }

  /**
   * 优雅关闭
   */
  async gracefulShutdown() {
    log('📢 接收到关闭信号，执行优雅关闭...');
    await this.stop();
    process.exit(0);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  const trader = new MartingaleTrader();
  
  // 处理关闭信号
  process.on('SIGINT', () => trader.gracefulShutdown());
  process.on('SIGTERM', () => trader.gracefulShutdown());
  
  // 启动交易器
  trader.start().catch(error => {
    log(`💥 启动失败: ${error.message}`, true);
    process.exit(1);
  });
}

module.exports = MartingaleTrader;