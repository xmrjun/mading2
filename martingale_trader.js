const fs = require('fs');
const path = require('path');
const MartingaleStrategy = require('./src/core/martingaleStrategy');
const BackpackService = require('./src/services/backpackService');
const PriceMonitor = require('./src/core/priceMonitor');
const { log, Logger } = require('./src/utils/logger');

/**
 * 马丁格尔交易应用主类 - 修正版
 * 实现真正的马丁格尔连续交易周期
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
    this.lastTradeTime = null;
    this.pendingOrders = new Map(); // 待处理订单
    
    // 定时器
    this.monitorInterval = null;
    this.orderCheckInterval = null;
    this.newTradeCheckInterval = null;
    
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
    if (this.newTradeCheckInterval) {
      clearInterval(this.newTradeCheckInterval);
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
   * 处理价格更新 - 修正版马丁格尔逻辑
   */
  async handlePriceUpdate(priceInfo) {
    this.currentPrice = priceInfo.price;
    
    if (!this.isRunning) return;
    
    try {
      const strategyStatus = this.martingaleStrategy.getStatus();
      
      // 如果策略在交易中，检查止盈止损
      if (strategyStatus.isInTrade && strategyStatus.currentCycle) {
        if (strategyStatus.currentCycle.status === 'holding') {
          // 检查止盈条件
          if (this.martingaleStrategy.shouldTakeProfit(this.currentPrice)) {
            await this.executeTakeProfit();
            return;
          }
          
          // 检查止损条件
          if (this.martingaleStrategy.shouldStopLoss(this.currentPrice)) {
            await this.executeStopLoss();
            return;
          }
        }
      }
      
    } catch (error) {
      log(`❌ 处理价格更新时出错: ${error.message}`, true);
    }
  }

  /**
   * 检查是否应该开始新的交易周期
   */
  async checkForNewTrade() {
    try {
      if (!this.isRunning) return;
      
      const strategyStatus = this.martingaleStrategy.getStatus();
      
      // 如果策略未在交易中且可以开始新交易
      if (!strategyStatus.isInTrade && this.martingaleStrategy.canStartNewTrade()) {
        
        // 检查是否有待处理订单
        if (this.pendingOrders.size > 0) {
          return; // 有待处理订单，等待
        }
        
        // 检查时间间隔 (避免频繁交易)
        const minInterval = 30000; // 30秒
        if (this.lastTradeTime && (Date.now() - this.lastTradeTime) < minInterval) {
          return;
        }
        
        // 确保有当前价格
        if (!this.currentPrice) {
          return;
        }
        
        // 开始新的交易周期
        await this.startNewTradeCycle();
      }
      
    } catch (error) {
      log(`❌ 检查新交易时出错: ${error.message}`, true);
    }
  }

  /**
   * 开始新的交易周期
   */
  async startNewTradeCycle() {
    try {
      const order = this.martingaleStrategy.startNewTradeCycle(
        this.currentPrice,
        this.config.trading.symbol,
        this.config.trading.tradingCoin
      );
      
      if (order) {
        await this.submitOrder(order);
        this.lastTradeTime = Date.now();
      }
      
    } catch (error) {
      log(`❌ 开始新交易周期时出错: ${error.message}`, true);
    }
  }

  /**
   * 执行止盈
   */
  async executeTakeProfit() {
    try {
      log('🎯 触发止盈条件...');
      
      const order = this.martingaleStrategy.createSellOrder(
        this.currentPrice,
        this.config.trading.symbol,
        this.config.trading.tradingCoin,
        'takeprofit'
      );
      
      if (order) {
        await this.submitOrder(order);
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
      log('⛔ 触发止损条件...');
      
      const order = this.martingaleStrategy.createSellOrder(
        this.currentPrice,
        this.config.trading.symbol,
        this.config.trading.tradingCoin,
        'stoploss'
      );
      
      if (order) {
        await this.submitOrder(order);
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
          timestamp: new Date(),
          cycle_id: order.cycle_id
        });
        
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
    
    // 新交易检查
    this.newTradeCheckInterval = setInterval(async () => {
      await this.checkForNewTrade();
    }, 10000); // 每10秒检查一次
    
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
          
          // 如果是交易周期中的订单被取消，需要重置策略状态
          this.handleOrderCancelled(orderInfo);
        }
        
      } catch (error) {
        log(`❌ 检查订单 ${orderId} 状态时出错: ${error.message}`);
      }
    }
  }

  /**
   * 处理订单成交 - 修正版
   */
  async handleOrderFilled(orderId, orderInfo, orderStatus) {
    this.pendingOrders.delete(orderId);
    
    // 准备订单成交信息
    const filledInfo = {
      id: orderId,
      side: orderInfo.side,
      quantity: orderInfo.quantity,
      price: orderInfo.price,
      filledQuantity: orderStatus.filledQuantity || orderInfo.quantity,
      avgPrice: orderStatus.avgPrice || orderInfo.price,
      cycle_id: orderInfo.cycle_id,
      timestamp: new Date()
    };
    
    if (orderInfo.side === 'Bid') {
      // 买入成交
      log(`✅ 买入成交: ${filledInfo.filledQuantity.toFixed(6)} ${this.config.trading.tradingCoin} @ ${filledInfo.avgPrice.toFixed(2)}`);
      
      // 通知策略买入成交
      this.martingaleStrategy.onBuyOrderFilled(filledInfo);
      
    } else if (orderInfo.side === 'Ask') {
      // 卖出成交
      log(`✅ 卖出成交: ${filledInfo.filledQuantity.toFixed(6)} ${this.config.trading.tradingCoin} @ ${filledInfo.avgPrice.toFixed(2)}`);
      
      // 通知策略卖出成交，完成交易周期
      this.martingaleStrategy.onSellOrderFilled(filledInfo);
    }
  }

  /**
   * 处理订单取消
   */
  handleOrderCancelled(orderInfo) {
    // 如果是买入订单被取消，重置交易状态
    if (orderInfo.side === 'Bid') {
      const strategyStatus = this.martingaleStrategy.getStatus();
      if (strategyStatus.currentCycle && strategyStatus.currentCycle.id === orderInfo.cycle_id) {
        log('⚠️ 买入订单被取消，重置交易周期');
        this.martingaleStrategy.isInTrade = false;
        this.martingaleStrategy.currentCycle = null;
      }
    }
    // 如果是卖出订单被取消，可能需要重新创建卖出订单
    else if (orderInfo.side === 'Ask') {
      log('⚠️ 卖出订单被取消，将在下次价格更新时重新检查');
    }
  }

  /**
   * 显示当前状态 - 修正版
   */
  displayStatus() {
    const strategyStatus = this.martingaleStrategy.getStatus();
    const riskAssessment = this.martingaleStrategy.getRiskAssessment();
    
    console.log('\n' + '='.repeat(60));
    console.log('📊 马丁格尔交易器状态');
    console.log('='.repeat(60));
    console.log(`🔄 运行状态: ${this.isRunning ? '运行中' : '已停止'}`);
    console.log(`💰 当前价格: ${this.currentPrice ? this.currentPrice.toFixed(2) : 'N/A'} USDC`);
    console.log(`📋 待处理订单: ${this.pendingOrders.size} 笔`);
    console.log('');
    console.log('🎲 马丁格尔策略状态:');
    console.log(`   策略状态: ${strategyStatus.isRunning ? '运行中' : '已停止'}`);
    console.log(`   交易状态: ${strategyStatus.isInTrade ? '交易中' : '空闲'}`);
    console.log(`   连续亏损: ${strategyStatus.consecutiveLosses}/${strategyStatus.maxLosses}`);
    console.log(`   当前Level: ${strategyStatus.consecutiveLosses}`);
    console.log(`   下次金额: ${riskAssessment.nextTradeAmount.toFixed(2)} USDC`);
    console.log(`   风险等级: ${riskAssessment.riskCategory} (${(riskAssessment.riskLevel * 100).toFixed(1)}%)`);
    console.log(`   总交易数: ${strategyStatus.totalTrades} 笔`);
    
    // 显示当前交易周期信息
    if (strategyStatus.currentCycle) {
      const cycle = strategyStatus.currentCycle;
      console.log('');
      console.log('🔄 当前交易周期:');
      console.log(`   周期ID: ${cycle.id}`);
      console.log(`   状态: ${cycle.status}`);
      console.log(`   Level: ${cycle.level}`);
      
      if (cycle.status === 'holding') {
        console.log(`   买入价: ${cycle.actualBuyPrice.toFixed(2)} USDC`);
        console.log(`   数量: ${cycle.actualQuantity.toFixed(6)}`);
        console.log(`   止盈价: ${cycle.takeProfitPrice.toFixed(2)} USDC`);
        console.log(`   止损价: ${cycle.stopLossPrice.toFixed(2)} USDC`);
        
        if (this.currentPrice) {
          const unrealizedPnL = (this.currentPrice - cycle.actualBuyPrice) * cycle.actualQuantity;
          console.log(`   未实现盈亏: ${unrealizedPnL.toFixed(2)} USDC`);
        }
      }
    }
    
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