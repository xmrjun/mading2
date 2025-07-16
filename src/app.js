const BackpackService = require('./services/backpackService');
// const ReconciliationService = require('./services/reconciliationService'); // 已禁用，使用日志统计
const PriceMonitor = require('./core/priceMonitor');
const TradingStrategy = require('./core/tradingStrategy');
const OrderManagerService = require('./core/orderManager');
const { Order, OrderManager } = require('./models/Order');
const TradeStats = require('./models/TradeStats');
const { log, defaultLogger } = require('./utils/logger');
const TimeUtils = require('./utils/timeUtils');
const Formatter = require('./utils/formatter');

/**
 * 应用程序类 - 协调各个组件工作
 */
class TradingApp {
  /**
   * 构造函数
   * @param {Object} config - 配置对象
   */
  constructor(config) {
    this.config = config;
    this.logger = defaultLogger;
    
    // 初始化组件
    this.backpackService = new BackpackService(config, this.logger);
    this.tradingStrategy = new TradingStrategy(this.logger, this.config);
    this.orderManager = new OrderManager();
    this.tradeStats = new TradeStats();
    
    // 初始化订单管理服务 - 传入统一的统计实例
    this.orderManagerService = new OrderManagerService(config, this.backpackService);
    // 确保使用同一套统计实例
    this.orderManagerService.orderManager = this.orderManager;
    this.orderManagerService.tradeStats = this.tradeStats;
    
        // 对账服务已禁用，使用日志统计系统
    // this.reconciliationService = new ReconciliationService(...);
    
    // 初始化价格监控器
    this.priceMonitor = new PriceMonitor({
      config: config,
      onPriceUpdate: this.handlePriceUpdate.bind(this),
      logger: this.logger
    });
    
    // 应用状态
    this.running = false;
    this.symbol = null;
    this.tradingCoin = null;
    this.currentPriceInfo = null;
    
    // 马丁格尔策略状态
    this.martingaleEnabled = config.trading?.martingaleEnabled || false;
    this.martingaleMultiplier = config.trading?.martingaleMultiplier || 2;
    this.maxConsecutiveLosses = config.trading?.maxConsecutiveLosses || 5;
    this.baseTotalAmount = config.trading?.totalAmount || 151;
    this.currentTotalAmount = this.baseTotalAmount;
    this.consecutiveLosses = 0;
    this.lastTradeResult = null;
    this.monitoringInterval = null;
    this.scriptStartTime = new Date();
    this.cycleLogFile = null;
    this.lastDisplayTime = 0;
    this.displayInitialized = false;
    this.takeProfitTriggered = false;
  }
  
  /**
   * 处理价格更新
   * @param {Object} priceInfo - 价格信息
   */
  async handlePriceUpdate(priceInfo) {
    // 确保从WebSocket接收到的价格能够被更新到应用状态
    this.currentPriceInfo = priceInfo;
    
    // 计算价格涨幅
    if (priceInfo && this.tradeStats.averagePrice > 0) {
      const priceIncrease = ((priceInfo.price - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
      this.currentPriceInfo.increase = priceIncrease;
      
              // 如果价格变化大，记录到终端
        if (Math.abs(priceIncrease) > 0.1) {
          const direction = priceIncrease >= 0 ? '上涨' : '下跌';
          log(`相对均价${direction}: ${Math.abs(priceIncrease).toFixed(2)}% (当前: ${priceInfo.price.toFixed(2)}, 均价: ${this.tradeStats.averagePrice.toFixed(2)})`);
        }
      
      // 🔑 关键修复：基于统计数据进行止盈检查，不依赖订单列表
      // 只要有持仓且有均价就监控止盈，支持外部转入的币种
      if (this.tradeStats.totalFilledQuantity > 0 && this.tradeStats.averagePrice > 0 && this.running && !this.takeProfitTriggered) {
        const takeProfitPercentage = this.config.trading.takeProfitPercentage;
        
        // 🔑 基于本地日志统计的止盈检查，不依赖API余额查询
        const currentPosition = this.tradeStats.totalFilledQuantity;
        const averagePrice = this.tradeStats.averagePrice;
        
        // 增强调试：详细记录止盈检查状态
        if (priceIncrease > (takeProfitPercentage * 0.8)) { // 接近止盈目标时开始详细日志
          log(`🎯 止盈检查: 当前涨幅 ${priceIncrease.toFixed(3)}% | 目标 ${takeProfitPercentage}% | 进度 ${(priceIncrease/takeProfitPercentage*100).toFixed(1)}%`);
          log(`   持仓数量: ${currentPosition.toFixed(6)} ${this.tradingCoin} | 平均价格: ${averagePrice.toFixed(2)} USDC`);
        }
        
        // 检查是否达到止盈条件
        const takeProfitReached = this.tradingStrategy.isTakeProfitTriggered(
          priceInfo.price, 
          averagePrice, 
          takeProfitPercentage
        );
        
        if (takeProfitReached) {
          const potentialProfit = (priceInfo.price - averagePrice) * currentPosition;
          
          log(`\n===== 🎉 止盈条件达成！=====`);
          log(`当前价格: ${priceInfo.price} USDC`);
          log(`平均买入价: ${averagePrice.toFixed(2)} USDC`);
          log(`涨幅: ${priceIncrease.toFixed(2)}% >= 止盈点: ${takeProfitPercentage}%`);
          log(`持仓数量: ${currentPosition.toFixed(6)} ${this.tradingCoin}`);
          log(`预计盈利: ${potentialProfit.toFixed(2)} USDC`);
          log('准备卖出获利...');
          
          // 设置止盈触发标志，避免重复触发
          this.takeProfitTriggered = true;
          
          // 执行止盈操作
          this.executeTakeProfit();
        }
      } else {
        // 🔑 异常情况高亮提示
        if (this.tradeStats.totalFilledQuantity > 0 && this.tradeStats.averagePrice === 0) {
          log(`🚨 [ERROR] 当前${this.tradingCoin}有余额但均价为0，止盈/统计功能已暂停！`, true);
          log(`📢 [ERROR] 请手动补录买入均价或重置tradeStats！`, true);
          log(`🔧 [ERROR] 解决方案：使用 --fresh 重新开始或手动设置均价`, true);
        } else if (this.tradeStats.totalFilledQuantity === 0) {
          // 无持仓时不记录（避免日志过多）
        } else if (!this.running) {
          log(`⚠️  止盈检查跳过: 应用未运行 (running=${this.running})`);
        } else if (this.takeProfitTriggered) {
          log(`⚠️  止盈检查跳过: 止盈已触发 (takeProfitTriggered=${this.takeProfitTriggered})`);
        }
      }
    }
    
    // 更新显示（限制频率）
    const now = Date.now();
    if (!this.lastDisplayTime || (now - this.lastDisplayTime) > 15000) {
      this.displayAccountInfo();
      this.lastDisplayTime = now;
    }
  }
  


  /**
   * 更新马丁格尔策略的总投资金额
   */
  updateMartingaleTotalAmount() {
    if (!this.martingaleEnabled) return;
    
    log('\n===== 🎲 马丁格尔策略金额调整 =====');
    
    // 根据上次交易结果调整投资金额
    if (this.lastTradeResult === 'loss') {
      // 上次亏损，增加投资金额
      const previousAmount = this.currentTotalAmount;
      this.consecutiveLosses++;
      this.currentTotalAmount *= this.martingaleMultiplier;
      
      log(`📉 上次交易结果: 亏损`);
      log(`🔼 投资金额递增: ${previousAmount} → ${this.currentTotalAmount} USDC (${this.martingaleMultiplier}倍)`);
      log(`⚠️  连续亏损次数: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
      
      // 计算累计风险
      const totalRisk = this.calculateTotalInvested();
      log(`💰 累计投资风险: ${totalRisk.toFixed(2)} USDC`);
      
      // 检查是否超过最大连续亏损限制
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        log(`🚫 达到最大连续亏损限制(${this.maxConsecutiveLosses}次)，策略暂停！`, true);
        this.running = false;
        return;
      }
      
    } else if (this.lastTradeResult === 'profit') {
      // 上次盈利，重置投资金额
      const totalInvested = this.calculateTotalInvested();
      log(`📈 上次交易结果: 盈利`);
      log(`🎉 本轮累计投资: ${totalInvested.toFixed(2)} USDC`);
      log(`🔄 重置投资金额: ${this.currentTotalAmount} → ${this.baseTotalAmount} USDC`);
      
      this.consecutiveLosses = 0;
      this.currentTotalAmount = this.baseTotalAmount;
      
    } else {
      // 首次执行
      log(`🎯 策略首次启动`);
      log(`💵 基础投资金额: ${this.currentTotalAmount} USDC`);
    }
    
    log('=====================================\n');
  }
  
  /**
   * 显示马丁格尔策略状态
   */
  displayMartingaleStatus() {
    if (!this.martingaleEnabled) return;
    
    log('\n===== 🎲 马丁格尔策略状态 =====');
    log(`启用状态: ${this.martingaleEnabled ? '启用' : '禁用'}`);
    log(`基础投资金额: ${this.baseTotalAmount} USDC`);
    log(`当前投资金额: ${this.currentTotalAmount} USDC`);
    log(`递增倍数: ${this.martingaleMultiplier}倍`);
    log(`连续亏损次数: ${this.consecutiveLosses}/${this.maxConsecutiveLosses}`);
    log(`上次交易结果: ${this.lastTradeResult || '无'}`);
    
    if (this.consecutiveLosses > 0) {
      const totalInvested = this.calculateTotalInvested();
      log(`累计投资: ${totalInvested.toFixed(2)} USDC`);
      log(`风险提示: ${this.consecutiveLosses >= 3 ? '🔴 高风险' : '🟡 中等风险'}`);
    }
    
    log('===============================\n');
  }
  
  /**
   * 计算累计投资金额
   */
  calculateTotalInvested() {
    let total = 0;
    let amount = this.baseTotalAmount;
    
    for (let i = 0; i <= this.consecutiveLosses; i++) {
      total += amount;
      amount *= this.martingaleMultiplier;
    }
    
    return total;
  }
  
  /**
   * 处理交易结果（用于马丁格尔策略）
   */
  handleTradeResult(isProfit) {
    if (!this.martingaleEnabled) return;
    
    this.lastTradeResult = isProfit ? 'profit' : 'loss';
    
    if (isProfit) {
      log(`📈 交易结果: 盈利 - 马丁格尔策略将重置`);
    } else {
      log(`📉 交易结果: 亏损 - 马丁格尔策略将增加投资金额`);
    }
  }
  
  /**
   * 处理马丁格尔策略的盈利情况
   */
  handleMartingaleProfit() {
    if (!this.martingaleEnabled) return;
    
    this.handleTradeResult(true);
    
    // 计算累计投资和盈利
    const totalInvested = this.calculateTotalInvested();
    const profit = this.tradeStats.totalFilledAmount * (this.currentPriceInfo?.increase || 0) / 100;
    
    log('🎉 马丁格尔策略止盈成功！');
    log(`   本轮累计投资: ${totalInvested.toFixed(2)} USDC`);
    log(`   预计盈利: ${profit.toFixed(2)} USDC`);
    log(`   投资金额将重置为: ${this.baseTotalAmount} USDC`);
  }
  
  /**
   * 处理马丁格尔策略的亏损情况
   */
  handleMartingaleLoss() {
    if (!this.martingaleEnabled) return;
    
    this.handleTradeResult(false);
    
    log('⚠️ 马丁格尔策略检测到亏损');
    log(`   下次投资金额将调整为: ${this.currentTotalAmount * this.martingaleMultiplier} USDC`);
  }

  /**
   * 启动定时对账功能（已禁用，使用日志统计系统）
   */
  startScheduledReconciliation() {
    // 🔑 现在有了日志统计系统，不需要定时对账
    log('ℹ️  定时对账功能已禁用 - 使用日志统计系统');
    return;
  }

  /**
   * 手动设置均价的方法（仅基于本地统计）
   * @param {number} averagePrice - 手动设置的均价
   * @param {number} quantity - 持仓数量，如不提供则使用当前本地统计
   */
  async setManualAveragePrice(averagePrice, quantity = null) {
    if (!averagePrice || averagePrice <= 0) {
      log('❌ 无效的均价设置', true);
      return false;
    }
    
    try {
      // 使用提供的数量或当前本地统计的数量
      const currentQuantity = quantity || this.tradeStats.totalFilledQuantity;
      
      if (currentQuantity <= 0) {
        log('❌ 当前无持仓数据，请提供持仓数量', true);
        return false;
      }
      
      // 重新计算统计数据
      const totalAmount = currentQuantity * averagePrice;
      
      this.tradeStats.totalFilledQuantity = currentQuantity;
      this.tradeStats.totalFilledAmount = totalAmount;
      this.tradeStats.averagePrice = averagePrice;
      this.tradeStats.filledOrders = 1; // 设置为1笔虚拟订单
      this.tradeStats.lastUpdateTime = new Date();
      
      log(`✅ 手动设置均价成功:`);
      log(`   持仓数量: ${currentQuantity.toFixed(6)} ${this.tradingCoin}`);
      log(`   设置均价: ${averagePrice.toFixed(2)} USDC`);
      log(`   总成本: ${totalAmount.toFixed(2)} USDC`);
      
      // 🔑 记录手动设置均价到日志
      if (this.logBasedStats) {
        this.logBasedStats.logManualAveragePriceSet(averagePrice, currentQuantity);
      }
      
      return true;
    } catch (error) {
      log(`❌ 设置均价失败: ${error.message}`, true);
      return false;
    }
  }

  /**
   * 执行止盈操作
   */
  async executeTakeProfit() {
    try {
      // 先取消所有未成交的买单
      await this.cancelAllOrders();
      
      // 执行卖出操作
      await this.sellAllPosition();
      
      // 🎲 马丁格尔策略：记录盈利，重置投资金额
      if (this.martingaleEnabled) {
        this.handleMartingaleProfit();
      }
      
      // 清除监控间隔
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
      }
      
      // 检查是否需要在止盈后自动重置
      if (this.config.actions.restartAfterTakeProfit) {
        log('\n===== 止盈后自动重置应用状态 =====');
        
        // 先停止价格监控，确保WebSocket连接正确关闭
        log('停止价格监控和WebSocket连接...');
        this.priceMonitor.stopMonitoring();
        
        // 确保WebSocket连接被显式关闭
        if (this.priceMonitor.wsManager) {
          this.priceMonitor.wsManager.closeAllConnections();
          log('已关闭所有WebSocket连接');
        }
        
        // 重置应用状态
        this.resetAppState();
        
        // 重新初始化应用
        log('正在重新初始化交易环境...');
        await this.initialize();
        
        // 重新启动应用
        await this.start();
        
        // 重新执行交易策略
        await this.executeTrade();
      }
    } catch (error) {
      log(`执行止盈操作时出错: ${error.message}`, true);
    }
  }
  
  /**
   * 初始化交易环境
   */
  async initialize() {
    try {
      log('正在初始化交易环境...');
      
      // 读取并设置配置
      this.config = this.config || {};
      this.tradingCoin = this.config.trading?.tradingCoin || this.config.tradingCoin || 'BTC';
      this.symbol = `${this.tradingCoin}_USDC`;
      this.apiSymbol = this.symbol;  // 使用相同的格式，不需要转换
      
      log(`交易对: ${this.apiSymbol}`);
      
      // 初始化服务和管理器 - 重用已有实例，避免重复创建
      // 重置现有实例而不是创建新实例
      this.orderManager.reset();
      this.tradeStats.reset();
      
      // 确保传递logger给所有服务
      this.backpackService = new BackpackService(this.config, this.logger);
      this.priceMonitor = new PriceMonitor({
        config: this.config,
        onPriceUpdate: this.handlePriceUpdate.bind(this),
        logger: this.logger
      });
      this.tradingStrategy = new TradingStrategy(this.logger, this.config);
      
      // 🔑 初始化基于日志的统计服务
      const LogBasedStatsService = require('./services/logBasedStatsService');
      this.logBasedStats = new LogBasedStatsService(this.tradeStats, this.config, this.logger);
      
      log('所有服务初始化完成');
      
      // 记录应用启动时间
      this.startTime = new Date();
      log(`程序启动时间: ${this.startTime.toLocaleString()}`);
      
      // 初始化状态变量
      this.running = false;
      this.lastTradeTime = new Date();
      this.lastStatusLogTime = new Date();
      
      // 设置价格监控回调
      this.priceMonitor.onPriceUpdate = async (priceInfo) => {
        try {
          await this.handlePriceUpdate(priceInfo);
        } catch (error) {
          log(`价格更新处理失败: ${error.message}`, true);
        }
      };
      
      // 尝试获取初始价格
      try {
        const ticker = await this.backpackService.getTicker(this.apiSymbol);
        if (ticker && ticker.lastPrice) {
          log(`初始价格: ${ticker.lastPrice} USDC (来源: API)`);
          this.currentPrice = parseFloat(ticker.lastPrice);
        } else {
          log('警告: 无法获取初始价格');
        }
      } catch (error) {
        log(`获取初始价格失败: ${error.message}`);
      }
      
      // 根据启动参数决定是否恢复历史订单
      const skipHistory = process.argv.includes('--fresh') || process.argv.includes('--no-history');
      
      if (skipHistory) {
        log('🆕 全新启动模式：清理现有订单，从零开始');
        
        // 先取消所有未成交订单，避免遗漏
        try {
          log('正在取消所有现有未成交订单...');
          await this.backpackService.cancelAllOrders(this.symbol);
          log('✅ 已取消所有现有订单');
          
          // 等待一小段时间确保订单取消完成
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          log(`取消现有订单失败: ${error.message}`, true);
        }
        
        // 🔑 检查是否启用了持仓检测功能
        const skipFirstOrderIfPositioned = this.config.actions?.skipFirstOrderIfPositioned;
        
        if (skipFirstOrderIfPositioned) {
          log('🔍 正在检查账户持仓...');
          try {
            const position = await this.backpackService.getPosition(this.tradingCoin);
            const positionQuantity = parseFloat(position?.available || position?.total || '0');
            const threshold = this.config.advanced?.positionDetectionThreshold || 0.001;
            
            if (positionQuantity > threshold) {
              log(`⚠️  检测到当前持仓 ${this.tradingCoin} 不为0: ${positionQuantity.toFixed(6)}`);
              log(`📊 根据配置，已跳过自动挂首单！`);
              
              // 🔑 补录持仓统计数据
              this.tradeStats.totalFilledQuantity = positionQuantity;
              this.tradeStats.filledOrders = 1; // 标记为已有持仓
              
              // 🔑 设置标志，阻止后续的首单挂单
              this.skipFirstOrder = true;
              
              // 尝试从市场获取当前价格作为默认均价
              try {
                const ticker = await this.backpackService.getTicker(this.apiSymbol);
                if (ticker && ticker.lastPrice) {
                  const marketPrice = parseFloat(ticker.lastPrice);
                  this.tradeStats.averagePrice = marketPrice;
                  this.tradeStats.totalFilledAmount = positionQuantity * marketPrice;
                  
                  log(`📈 使用市场价格 ${marketPrice.toFixed(2)} USDC 作为默认均价`);
                  log(`💰 预估持仓价值: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
                } else {
                  log('⚠️  无法获取市场价格，建议手动设置均价');
                }
              } catch (priceError) {
                log(`获取市场价格失败: ${priceError.message}`);
              }
              
              // 🔑 如果启用了手动均价设置，提供提示
              if (this.config.advanced?.allowManualAveragePrice) {
                log('💡 提示：如需设置准确的持仓均价，请使用 setManualAveragePrice 方法');
              }
              
              // 🔑 记录持仓检测结果到日志
              if (this.logBasedStats) {
                this.logBasedStats.logPositionDetected(positionQuantity, this.tradeStats.averagePrice);
              }
              
            } else {
              log(`✅ 账户 ${this.tradingCoin} 持仓为空 (${positionQuantity.toFixed(6)})，将正常执行首单策略`);
              this.skipFirstOrder = false;
            }
          } catch (positionError) {
            log(`获取持仓信息失败: ${positionError.message}`, true);
            log('⚠️  由于无法获取持仓信息，将按正常流程执行首单策略');
            this.skipFirstOrder = false;
          }
        } else {
          log('🔄 未启用持仓检测功能，将正常执行首单策略');
          this.skipFirstOrder = false;
        }
        
        log('🔄 从当前状态开始，不统计历史订单');
      } else {
        log('📋 正常启动模式：恢复历史订单数据');
        await this.loadHistoricalOrders();
      }
      
      // 🔑 优先使用日志恢复统计（更可靠）
      log('📋 尝试从本地日志恢复交易统计...');
      const logRecoveryResult = await this.logBasedStats.recoverStatsFromLogs();
      
      if (logRecoveryResult.success && logRecoveryResult.recovered) {
        log('✅ 从日志成功恢复统计数据');
        log(`📊 恢复了 ${logRecoveryResult.tradeCount} 条交易记录`);
      } else {
        log('📋 日志恢复结果：' + logRecoveryResult.message);
        
        log('� 使用日志统计系统，不依赖API对账');
      }
      
      return true;
    } catch (error) {
      log(`初始化失败: ${error.message}`);
      return false;
    }
  }
  
  /**
   * 启动交易应用
   */
  async start() {
    try {
      if (this.running) {
        log('应用程序已经在运行中');
        return false;
      }
      
      // 初始化环境
      const initialized = await this.initialize();
      if (!initialized) {
        log('初始化失败，应用程序无法启动', true);
        return false;
      }
      
      // 启动价格监控
      this.priceMonitor.startMonitoring(this.symbol);

      // 🔑 定时对账功能已禁用，使用日志统计系统
      
      // 添加轮询检查机制，每5秒检查一次价格数据，避免WebSocket回调失败的情况
      this.priceCheckInterval = setInterval(async () => {
        try {
          let priceInfo = null;
          
          // 直接从priceMonitor获取价格数据
          if (this.priceMonitor.currentPrice > 0) {
            priceInfo = {
              price: this.priceMonitor.currentPrice,
              symbol: this.symbol,
              source: 'WebSocket轮询',
              updateTime: this.priceMonitor.lastUpdateTime || Date.now()
            };
            
            log(`轮询获取价格: ${priceInfo.price} USDC`);
          }
          // 如果priceMonitor没有价格数据，但WebSocketManager有
          else if (this.priceMonitor.wsManager && 
                  this.priceMonitor.wsManager.lastPriceData && 
                  this.priceMonitor.wsManager.lastPriceData.price > 0) {
            
            const wsData = this.priceMonitor.wsManager.lastPriceData;
            priceInfo = {
              price: wsData.price,
              symbol: wsData.symbol || this.symbol,
              source: 'WebSocketManager轮询',
              updateTime: wsData.time || Date.now()
            };
            
            log(`轮询从WebSocketManager获取价格: ${priceInfo.price} USDC`);
          }
          
          // ✅ 关键修复：调用完整的handlePriceUpdate方法，确保止盈检查正常运行
          if (priceInfo) {
            try {
              await this.handlePriceUpdate(priceInfo);
            } catch (error) {
              log(`价格更新处理失败: ${error.message}`, true);
            }
          }
        } catch (error) {
          log(`价格轮询错误: ${error.message}`, true);
        }
      }, 5000);
      
      this.running = true;
      
      // 返回成功
      return true;
    } catch (error) {
      log(`启动应用程序失败: ${error.message}`, true);
      this.stop();
      return false;
    }
  }
  
  /**
   * 停止交易应用
   */
  async stop() {
    if (!this.running) return;
    
    log('正在停止应用程序...');
    
    try {
      // 先取消所有订单
      try {
        await this.cancelAllOrders();
        log('已取消所有未完成订单');
      } catch (cancelError) {
        log(`取消订单时出错: ${cancelError.message}`, true);
      }
      
      // 停止WebSocket相关资源 - 增强错误处理
      try {
        // 停止价格监控
        if (this.priceMonitor) {
          log('正在停止价格监控...');
          this.priceMonitor.stopMonitoring();
          log('已停止价格监控');
          
          // 关闭WebSocket连接
          if (this.priceMonitor.wsManager) {
            log('正在关闭WebSocket连接...');
            this.priceMonitor.wsManager.closeAllConnections();
            log('已关闭所有WebSocket连接');
          }
        }
      } catch (wsError) {
        log(`关闭WebSocket连接时出错: ${wsError.message}`, true);
        // 尝试强制清理
        try {
          if (this.priceMonitor && this.priceMonitor.wsManager && this.priceMonitor.wsManager.ws) {
            this.priceMonitor.wsManager.ws.terminate();
            this.priceMonitor.wsManager.ws = null;
            log('已强制终止WebSocket连接');
          }
        } catch (forceCloseError) {
          log(`强制关闭WebSocket连接时出错: ${forceCloseError.message}`, true);
        }
      }
      
      // 清除所有定时器
      const timers = [
        this.monitoringInterval,
        this.priceCheckInterval,
        this.reconciliationTimer,
        this.priceMonitor?.checkInterval,
        this.priceMonitor?.wsManager?.heartbeatInterval,
        this.priceMonitor?.wsManager?.reconnectTimeout
      ];
      
      // 清除所有可能的定时器
      timers.forEach(timer => {
        if (timer) {
          try {
            clearInterval(timer);
            clearTimeout(timer);
          } catch (timerError) {
            log(`清除定时器时出错: ${timerError.message}`, true);
          }
        }
      });
      
      // 重置定时器引用
      this.monitoringInterval = null;
      this.priceCheckInterval = null;
      this.reconciliationTimer = null;
      if (this.priceMonitor) {
        this.priceMonitor.checkInterval = null;
        if (this.priceMonitor.wsManager) {
          this.priceMonitor.wsManager.heartbeatInterval = null;
          this.priceMonitor.wsManager.reconnectTimeout = null;
        }
      }
      
      log('已清除所有定时器');
      
      // 记录最终状态
      this.displayStats();
      
      // 标记为已停止
      this.running = false;
      log('应用程序已完全停止');
    } catch (error) {
      log(`停止应用程序时出错: ${error.message}`, true);
      // 即使出错也标记为已停止
      this.running = false;
    }
  }
  
  /**
   * 撤销所有未成交订单
   */
  async cancelAllOrders() {
    if (!this.running) {
      log('应用程序未运行，无法撤销订单');
      return false;
    }
    
    try {
      log(`开始撤销 ${this.symbol} 交易对的所有未完成订单...`);
      const result = await this.backpackService.cancelAllOrders(this.symbol);
      log(`撤销订单结果: ${JSON.stringify(result)}`);
      return true;
    } catch (error) {
      log(`撤销订单失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 执行交易操作
   */
  async executeTrade() {
    try {
      log('开始执行交易策略...');
      
      // 🎲 马丁格尔逻辑：根据上次交易结果调整总投资金额
      if (this.martingaleEnabled) {
        this.updateMartingaleTotalAmount();
      }
      
      // 🔑 检查是否需要跳过首单挂单
      if (this.skipFirstOrder) {
        log('🚫 检测到已有持仓，跳过首单挂单操作');
        log('📊 当前持仓统计:');
        log(`   持仓数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
        log(`   持仓均价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        log(`   持仓价值: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
        
        // 🔑 启动止盈监控，即使没有挂单也要监控止盈
        if (!this.monitoringInterval) {
          log('🎯 启动止盈监控系统...');
          this.startTakeProfitMonitoring();
        }
        
        return true; // 返回成功，表示策略已执行完成
      }
      
      // 检查当前价格
      if (!this.currentPrice || this.currentPrice <= 0) {
        log('警告: 当前价格无效，无法执行交易');
        return false;
      }
      
      log(`当前价格: ${this.currentPrice} USDC`);
      
      // 取消所有现有订单
      try {
        await this.backpackService.cancelAllOrders(this.apiSymbol);
        log('已取消所有现有订单');
      } catch (error) {
        log(`取消所有订单失败: ${error.message}`);
      }
      
      // 从配置中获取交易参数
      const maxDropPercentage = this.config.trading.maxDropPercentage;
      const totalAmount = this.currentTotalAmount; // 🎲 使用马丁格尔调整后的总投资金额
      const orderCount = this.config.trading.orderCount;
      const incrementPercentage = this.config.trading.incrementPercentage;
      const minOrderAmount = this.config.advanced?.minOrderAmount || 10;
      
      // 确保所有交易参数都有效
      if (!maxDropPercentage || !totalAmount || !orderCount || !incrementPercentage) {
        log('警告: 交易参数无效，请检查配置文件', true);
        return false;
      }
      
      // 计算阶梯订单
      const orders = this.tradingStrategy.calculateIncrementalOrders(
        this.currentPrice,
        maxDropPercentage,
        totalAmount,
        orderCount,
        incrementPercentage,
        minOrderAmount,
        this.tradingCoin,
        this.apiSymbol
      );
      
      if (!orders || orders.length === 0) {
        log('警告: 没有生成有效的订单');
        return false;
      }
      
      // 🎲 显示马丁格尔策略详情
      if (this.martingaleEnabled) {
        log('\n===== 🎲 马丁格尔阶梯挂单策略 =====');
        log(`📊 当前轮次投资金额: ${totalAmount} USDC`);
        log(`📈 价格回撤范围: 当前价格 ${this.currentPrice.toFixed(2)} → ${(this.currentPrice * (1 - maxDropPercentage / 100)).toFixed(2)} USDC (-${maxDropPercentage}%)`);
        log(`🎯 生成 ${orders.length} 个阶梯限价单`);
        
        // 显示每层挂单详情
        orders.forEach((order, index) => {
          const dropPercent = ((this.currentPrice - order.price) / this.currentPrice * 100).toFixed(2);
          log(`   第${index + 1}层: ${order.price.toFixed(2)} USDC (-${dropPercent}%), 数量: ${order.quantity.toFixed(6)} ${this.tradingCoin}, 金额: ${order.amount.toFixed(2)} USDC`);
        });
        
        log('=========================================\n');
      } else {
        log(`已生成 ${orders.length} 个阶梯买单`);
      }
      
      // 创建订单
      let successCount = 0;
      for (const order of orders) {
        try {
          // 检查是否已存在相同的订单
          const orderSignature = `${order.symbol}_${order.price}_${order.quantity}`;
          if (this.orderManager.hasOrderSignature(orderSignature)) {
            log(`跳过重复订单: ${orderSignature}`);
            continue;
          }
          
          // 创建订单
          const result = await this.backpackService.createOrder({
            symbol: this.apiSymbol,
            side: 'Bid',
            orderType: 'Limit',
            price: order.price.toFixed(2),
            quantity: order.quantity.toFixed(6)
          });
          
          if (result && result.id) {
            // 添加到订单管理器
            const newOrder = new Order({
              id: result.id,
              symbol: order.symbol,
              side: 'Bid',
              price: order.price,
              quantity: order.quantity,
              status: result.status || 'New'
            });
            
            // 添加订单到管理器，并记录这个签名
            this.orderManager.addOrder(newOrder);
            
            // 增加总订单计数 - 确保使用主应用的统计实例
            this.tradeStats.totalOrders++;
            
            // 🔑 记录买单创建到日志
            this.logBasedStats.logBuyOrderCreated(result.id, order.price, order.quantity);
            
            // 如果订单立即成交，更新统计
            if (newOrder.status === 'Filled') {
              this.tradeStats.updateStats(newOrder);
              // 🔑 记录买单成交到日志
              this.logBasedStats.logBuyOrderFilled(
                result.id, 
                order.quantity, 
                order.price * order.quantity, 
                order.price
              );
            }
            
            // 在终端显示订单创建信息（确保显示）
            log(`订单已创建: ${result.id} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
            successCount++;
          } else {
            log(`订单创建失败: ${JSON.stringify(order)}`);
          }
        } catch (error) {
          log(`创建订单失败: ${error.message}, 订单: ${JSON.stringify(order)}`);
        }
      }
      
      log(`成功创建 ${successCount}/${orders.length} 个订单`);
      
      // 🎲 显示马丁格尔状态
      if (this.martingaleEnabled && successCount > 0) {
        this.displayMartingaleStatus();
      }
      
      // 更新最后交易时间
      this.lastTradeTime = new Date();
      
      // 启动止盈监控（仅在未运行时启动，避免重复重置状态）
      if (!this.monitoringInterval) {
        log('🎯 启动止盈监控系统...');
        this.startTakeProfitMonitoring();
      } else {
        log('🎯 止盈监控已在运行，跳过重复启动');
      }
      
      return successCount > 0;
    } catch (error) {
      log(`执行交易操作失败: ${error.message}`);
      if (error.stack) {
        log(`错误堆栈: ${error.stack}`);
      }
      return false;
    }
  }
  
  /**
   * 备用订单状态检查机制（当批量API失败时使用）
   */
  async checkOrderStatusWithBackup() {
    try {
      log('🔍 启动备用订单状态检查...');
      
      // 获取所有已创建的订单ID
      const allOrderIds = this.orderManager.getAllCreatedOrderIds();
      log(`📋 检查 ${allOrderIds.length} 个已创建的订单状态`);
      
      let checkedCount = 0;
      let filledCount = 0;
      
      for (const orderId of allOrderIds) {
        try {
          // 尝试单独查询订单状态
          const orderDetail = await this.backpackService.getOrderDetails(orderId);
          
          if (orderDetail && orderDetail.status === 'Filled') {
            const localOrder = this.orderManager.getOrder(orderId);
            if (localOrder && !this.tradeStats.isOrderProcessed(orderId)) {
              
              // 更新本地订单状态
              localOrder.status = 'Filled';
              localOrder.filledQuantity = parseFloat(orderDetail.filledQuantity || orderDetail.quantity);
              localOrder.filledAmount = parseFloat(orderDetail.filledAmount || (orderDetail.price * orderDetail.quantity));
              
              // 更新统计
              this.tradeStats.updateStats(localOrder);
              
              // 记录到日志
              this.logBasedStats.logBuyOrderFilled(
                orderId,
                localOrder.filledQuantity,
                localOrder.filledAmount,
                localOrder.price
              );
              
              log(`✅ 发现成交订单: ${orderId} - ${localOrder.filledQuantity} ${this.tradingCoin} @ ${localOrder.price} USDC`);
              filledCount++;
            }
          }
          
          checkedCount++;
          
          // 避免API请求过快
          await new Promise(resolve => setTimeout(resolve, 200));
          
        } catch (singleOrderError) {
          log(`单个订单查询失败 ${orderId}: ${singleOrderError.message}`, true);
          // 单个失败不影响其他订单检查
        }
      }
      
      log(`📊 备用检查完成: 检查了 ${checkedCount}/${allOrderIds.length} 个订单，发现 ${filledCount} 个新成交`);
      
    } catch (error) {
      log(`备用订单状态检查失败: ${error.message}`, true);
    }
  }
  
  /**
   * 查询订单并更新统计
   */
  async queryOrdersAndUpdateStats() {
    try {
      log('查询当前交易周期新成交的订单...');
      
      // 获取当前未成交订单
      let openOrders = [];
      let currentOpenOrderIds = new Set();
      
      try {
        openOrders = await this.backpackService.getOpenOrders(this.symbol);
        currentOpenOrderIds = new Set(openOrders.map(order => order.id));
      } catch (openOrdersError) {
        log(`获取未成交订单失败: ${openOrdersError.message}`, true);
        
        // 🔑 当API失败时，尝试逐个检查已知订单的状态
        await this.checkOrderStatusWithBackup();
      }
      
      // 获取所有历史订单（包括已成交和已取消的）
      try {
        const allOrders = await this.backpackService.getOrderHistory(this.symbol);
        
        // 更新所有历史订单的状态
        if (allOrders && allOrders.length > 0) {
          log(`获取到 ${allOrders.length} 个历史订单记录`);
          
          // 处理历史订单
          for (const historyOrder of allOrders) {
            if (historyOrder.id && historyOrder.status === 'Filled') {
              // 查找本地订单记录
              const localOrder = this.orderManager.getOrder(historyOrder.id);
              
              // 如果本地有此订单且未处理，更新其状态
              if (localOrder && !this.tradeStats.isOrderProcessed(historyOrder.id)) {
                // 使用API返回的实际成交数据
                localOrder.status = 'Filled';
                localOrder.filledQuantity = parseFloat(historyOrder.filledQuantity || historyOrder.quantity);
                localOrder.filledAmount = parseFloat(historyOrder.filledAmount || (historyOrder.price * historyOrder.quantity));
                
                log(`从API确认订单已成交: ${historyOrder.id} - ${localOrder.quantity} ${this.tradingCoin} @ ${localOrder.price} USDC`);
              }
            }
          }
        }
      } catch (historyError) {
        log(`获取订单历史出错: ${historyError.message}`, true);
        // 继续处理，使用备用方法
      }
      
      // 🔑 增强部分成交实时统计：检查所有订单的成交状态变化
      const filledOrders = [];
      const partiallyFilledOrders = [];
      
      for (const orderId of this.orderManager.getAllCreatedOrderIds()) {
        const order = this.orderManager.getOrder(orderId);
        if (!order) continue;
        
        // 检查是否在未成交列表中
        const isInOpenOrders = currentOpenOrderIds.has(orderId);
        
        if (!isInOpenOrders) {
          // 订单不在未成交列表中，说明已完全成交
          if (!this.tradeStats.isOrderProcessed(orderId)) {
            // 准备更新数据
            const updateData = {
              status: 'Filled'
            };
            
            // 确保设置正确的成交数量和金额
            if (order.filledQuantity <= 0) {
              updateData.filledQuantity = order.quantity;
            }
            
            if (order.filledAmount <= 0) {
              updateData.filledAmount = order.price * order.quantity;
            }
            
            // 使用update方法更新订单，确保remainingQuantity被正确设置
            order.update(updateData);
            
            // 添加到已成交订单列表
            filledOrders.push(order);
            
            // 记录订单成交信息
            log(`🎯 [统计] 订单完全成交: ${orderId} - ${order.quantity} ${this.tradingCoin} @ ${order.price} USDC`);
          }
        } else {
          // 订单还在未成交列表中，但可能有部分成交
          const openOrder = openOrders.find(o => o.id === orderId);
          if (openOrder) {
            const apiFilledQuantity = parseFloat(openOrder.filledQuantity || 0);
            const apiFilledAmount = parseFloat(openOrder.filledAmount || 0);
            const previousFilledQuantity = parseFloat(order.filledQuantity || 0);
            
            // 🔑 关键：检查是否有新的部分成交
            if (apiFilledQuantity > previousFilledQuantity) {
              const newFilledQuantity = apiFilledQuantity - previousFilledQuantity;
              const newFilledAmount = apiFilledAmount - parseFloat(order.filledAmount || 0);
              
              log(`📊 [统计] 检测到部分成交: ${orderId}`);
              log(`   新成交数量: ${newFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
              log(`   新成交金额: ${newFilledAmount.toFixed(2)} USDC`);
              
              // 更新订单的成交信息
              order.update({
                filledQuantity: apiFilledQuantity,
                filledAmount: apiFilledAmount,
                status: apiFilledQuantity >= order.quantity ? 'Filled' : 'PartiallyFilled'
              });
              
              // 🔑 关键：实时更新统计数据（只统计新增成交部分）
              this.tradeStats.updatePartialFillStats(orderId, newFilledQuantity, newFilledAmount);
              
              // 🔑 记录部分成交到日志
              this.logBasedStats.logBuyPartialFilled(orderId, newFilledQuantity, newFilledAmount);
              
              partiallyFilledOrders.push({
                order: order,
                newFilledQuantity: newFilledQuantity,
                newFilledAmount: newFilledAmount
              });
              
              log(`✅ [统计] 部分成交统计已更新: 累计成交量 ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
            }
          }
        }
      }
      
      // 更新统计信息
      let updatedCount = 0;
      for (const order of filledOrders) {
        const result = this.tradeStats.updateStats(order);
        if (result) {
          updatedCount++;
          // 🔑 记录完全成交到日志
          this.logBasedStats.logBuyOrderFilled(
            order.id, 
            order.quantity, 
            order.price * order.quantity, 
            order.price
          );
          
          // 如果统计更新成功，记录成交信息
          log(`更新交易统计: 成交订单数=${this.tradeStats.filledOrders}, 均价=${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        }
      }
      
      // 如果有订单更新，记录详细统计
      if (updatedCount > 0) {
        this.logger.logToFile(`===订单统计更新===`);
        this.logger.logToFile(`总订单数: ${this.tradeStats.totalOrders}`);
        this.logger.logToFile(`成交订单数: ${this.tradeStats.filledOrders}`);
        this.logger.logToFile(`总成交数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
        this.logger.logToFile(`总成交金额: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
        this.logger.logToFile(`平均成交价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
        
        // 🔑 记录统计更新到日志
        this.logBasedStats.logStatsUpdated();
      }
      
      // 更新订单管理器中的待处理订单ID列表
      this.orderManager.updatePendingOrderIds(Array.from(currentOpenOrderIds));
      
      return filledOrders.length > 0;
    } catch (error) {
      log(`查询订单历史并更新统计失败: ${error.message}`, true);
      return false;
    }
  }
  
  /**
   * 开始监控止盈条件
   */
  async startTakeProfitMonitoring() {
    if (!this.running) {
      log('应用程序未运行，无法开始监控止盈条件');
      return false;
    }
    
    // 获取止盈百分比
    const takeProfitPercentage = this.config.trading.takeProfitPercentage;
    log(`\n开始监控止盈条件 (${takeProfitPercentage}%)...`);
    
    // 首次显示账户信息
    this.displayAccountInfo();
    
    // 启动监控间隔
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // 监控变量
    let monitoringAttempts = 0;
    // ❌ 删除：不应该在这里重置止盈状态！
    // this.takeProfitTriggered = false;  // 这行导致了止盈失效！
    let lastOrderCheckTime = Date.now();
    
    // 无订单成交自动重启相关变量
    const autoRestartNoFill = this.config.actions.autoRestartNoFill === true;
    const noFillRestartMinutes = this.config.advanced.noFillRestartMinutes || 60;
    const noFillRestartMs = noFillRestartMinutes * 60 * 1000;
    const initialStartTime = Date.now();
    let hadFilledOrders = this.tradeStats.filledOrders > 0;
    
    if (autoRestartNoFill) {
      log(`启用无订单成交自动重置: 如果 ${noFillRestartMinutes} 分钟内没有订单成交，将自动重置应用状态`);
    }
    
    // 添加心跳计时器
    const heartbeatInterval = setInterval(() => {
      const timeNow = new Date().toLocaleString();
      this.logger.logToFile(`心跳检查: 脚本正在运行 ${timeNow}`);
    }, 60000);
    
    this.monitoringInterval = setInterval(async () => {
      try {
        monitoringAttempts++;
        
        // 记录每一轮监控的开始
        const cycleStartTime = Date.now();
        this.logger.logToFile(`开始第 ${monitoringAttempts} 轮订单监控检查`);
        
        // 更新显示
        this.displayAccountInfo();
        
        // 每次检查前都更新统计数据，确保使用最新的订单状态
        let hasFilledOrders = false;
        try {
          hasFilledOrders = await this.queryOrdersAndUpdateStats();
        } catch (statsError) {
          this.logger.logToFile(`更新订单统计时出错: ${statsError.message}`, true);
        }
        
        // 如果之前没有成交订单，但现在有了，则记录这一状态变化
        if (!hadFilledOrders && hasFilledOrders) {
          this.logger.logToFile(`检测到首次订单成交，自动重置计时器已取消`);
          hadFilledOrders = true;
        }
        
        // 检查是否需要因无订单成交而重置
        if (autoRestartNoFill && !hadFilledOrders && this.tradeStats.filledOrders === 0) {
          const runningTimeMs = Date.now() - initialStartTime;
          
          if (runningTimeMs >= noFillRestartMs) {
            log(`\n===== 无订单成交自动重置触发 =====`);
            log(`已运行 ${Math.floor(runningTimeMs / 60000)} 分钟无任何订单成交`);
            log(`根据配置，系统将重置应用状态并重新开始交易...`);
            
            // 先取消所有未成交订单
            await this.cancelAllOrders();
            
            // 添加卖出余额操作，与止盈流程保持一致
            try {
              log('执行卖出持仓操作...');
              // 卖出所有持仓
              await this.sellAllPosition();
            } catch (sellError) {
              log(`卖出操作失败: ${sellError.message}`, true);
              // 即使卖出失败也继续重置流程
            }
            
            clearInterval(heartbeatInterval);
            clearInterval(this.monitoringInterval);
            
            // 显式停止价格监控，确保WebSocket连接正确关闭
            log('停止价格监控和WebSocket连接...');
            this.priceMonitor.stopMonitoring();
            
            // 确保WebSocket连接被显式关闭
            if (this.priceMonitor.wsManager) {
              this.priceMonitor.wsManager.closeAllConnections();
              log('已关闭所有WebSocket连接');
            }
            
            // 重置应用状态
            this.resetAppState();
            
            // 重新初始化应用
            log('正在重新初始化交易环境...');
            await this.initialize();
            
            // 重新启动应用
            await this.start();
            
            // 重新执行交易策略
            await this.executeTrade();
            
            return true;
          }
        }
        
        // 定期检查未成交的订单状态
        const orderCheckIntervalMs = Math.max(1, this.config.advanced.checkOrdersIntervalMinutes || 10) * 60 * 1000;
        const checkTimeNow = Date.now();
        
        if (checkTimeNow - lastOrderCheckTime > orderCheckIntervalMs) {
          await this.queryOrdersAndUpdateStats();
          lastOrderCheckTime = checkTimeNow;
        }
        
        // 注：价格和止盈检查已经在handlePriceUpdate方法中处理
        
      } catch (error) {
        log(`监控过程中发生错误: ${error.message}`, true);
        // 出错后等待短一点的时间再继续，避免长时间卡住
      }
    }, this.config.advanced.monitorIntervalSeconds * 1000);
  }
  
  /**
   * 卖出所有持仓
   */
  async sellAllPosition() {
    try {
      // 获取当前持仓情况 - 修正：使用tradingCoin而非symbol获取持仓
      const position = await this.backpackService.getPosition(this.tradingCoin);
      if (!position) {
        log('无法获取持仓信息');
        return null;
      }
      
      log(`获取到${this.tradingCoin}持仓信息: ${JSON.stringify(position)}`);
      
      // 确保quantity是有效的数字，使用available属性作为可用数量
      const rawQuantity = parseFloat(position.available || position.total || "0");
      if (isNaN(rawQuantity) || rawQuantity <= 0) {
        log(`持仓数量无效: ${position.available}, 总量: ${position.total}`);
        return null;
      }
      
      // 获取当前市场价格
      const ticker = await this.backpackService.getTicker(this.symbol);
      if (!ticker || !ticker.lastPrice) {
        log('无法获取当前市场价格');
        return null;
      }
      
      const currentPrice = parseFloat(ticker.lastPrice);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        log(`获取的价格无效: ${ticker.lastPrice}`);
        return null;
      }
      
      // 设置卖出价格
      const sellPrice = this.tradingStrategy.calculateOptimalSellPrice(currentPrice, this.tradingCoin);
      if (isNaN(sellPrice) || sellPrice <= 0) {
        log(`计算的卖出价格无效: ${sellPrice}`);
        return null;
      }
      
      // 调整数量精度
      const quantity = Formatter.adjustQuantityToStepSize(rawQuantity, this.tradingCoin, this.config);
      if (isNaN(quantity) || quantity <= 0) {
        log(`调整后的数量无效: ${quantity}`);
        return null;
      }
      
      log(`准备卖出: ${quantity} ${this.tradingCoin}, 当前市场价=${currentPrice}, 卖出价=${sellPrice}`);
      
      // 创建卖出订单 - 修正参数顺序
      const response = await this.backpackService.createSellOrder(
        sellPrice,
        quantity,
        this.symbol
      );
      
      if (response && response.id) {
        log(`卖出订单创建成功: 订单ID=${response.id}, 状态=${response.status}`);
        
        // 检查订单是否完全成交
        let fullyFilled = response.status === 'Filled';
        
        // 如果订单未完全成交，尝试再次以更低价格卖出剩余部分
        if (!fullyFilled) {
          log('订单未完全成交，检查剩余数量并尝试以更低价格卖出');
          
          // 等待一小段时间，让订单有时间处理
          await TimeUtils.delay(2000);
          
          // 获取更新后的持仓
          const updatedPosition = await this.backpackService.getPosition(this.tradingCoin);
          if (updatedPosition && parseFloat(updatedPosition.available || updatedPosition.total || "0") > 0) {
            const updatedRawQuantity = parseFloat(updatedPosition.quantity);
            if (isNaN(updatedRawQuantity) || updatedRawQuantity <= 0) {
              log(`更新后的持仓数量无效: ${updatedPosition.quantity}`);
              return response;
            }
            
            const remainingQuantity = Formatter.adjustQuantityToStepSize(updatedRawQuantity, this.tradingCoin, this.config);
            if (isNaN(remainingQuantity) || remainingQuantity <= 0) {
              log(`调整后的剩余数量无效: ${remainingQuantity}`);
              return response;
            }
            
            log(`仍有 ${remainingQuantity} ${this.tradingCoin} 未售出，尝试以更低价格卖出`);
            
            // 计算更低的卖出价格
            const lowerSellPrice = this.tradingStrategy.calculateSecondSellPrice(currentPrice, this.tradingCoin);
            if (isNaN(lowerSellPrice) || lowerSellPrice <= 0) {
              log(`计算的第二次卖出价格无效: ${lowerSellPrice}`);
              return response;
            }
            
            // 创建第二次卖出订单 - 修正参数顺序
            const secondResponse = await this.backpackService.createSellOrder(
              lowerSellPrice,
              remainingQuantity,
              this.symbol
            );
            
            if (secondResponse && secondResponse.id) {
              log(`第二次卖出订单创建成功: 订单ID=${secondResponse.id}, 状态=${secondResponse.status}`);
            }
          } else {
            log(`所有 ${this.tradingCoin} 已售出`);
          }
        }
        
        return response;
      } else {
        throw new Error('卖出订单创建失败：响应中没有订单ID');
      }
    } catch (error) {
      log(`卖出失败: ${error.message}`, true);
      return null;
    }
  }
  
  /**
   * 显示账户信息
   */
  displayAccountInfo() {
    try {
      // 准备数据
      const timeNow = new Date().toLocaleString();
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      const elapsedTime = TimeUtils.getElapsedTime(this.scriptStartTime);
      
      // 价格信息
      let priceInfo = "等待WebSocket数据...";
      let priceChangeSymbol = "";
      let percentProgress = "0";
      
      // 获取当前的WebSocket连接状态
      let wsConnected = this.priceMonitor.isMonitoring();
      
      // 显示WebSocket连接状态及上次更新时间
      let wsStatusInfo = wsConnected ? "已连接" : "连接中...";
      
      // 如果有价格监控的上次更新时间，显示距离上次更新的时间
      if (this.priceMonitor.lastUpdateTime) {
        const lastUpdateTimeString = new Date(this.priceMonitor.lastUpdateTime).toLocaleTimeString();
        const dataAge = Math.floor((Date.now() - this.priceMonitor.lastUpdateTime) / 1000);
        wsStatusInfo += ` (${lastUpdateTimeString}, ${dataAge}秒前)`;
      }
      
      // 尝试所有可能的来源获取价格数据
      let priceFound = false;
      
      // 1. 首先尝试使用已有的价格信息
      if (this.currentPriceInfo && this.currentPriceInfo.price) {
        const currentPrice = this.currentPriceInfo.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC`;
        
        // 如果有价格数据来源，显示来源
        if (this.currentPriceInfo.source) {
          priceInfo += ` (来源: ${this.currentPriceInfo.source})`;
        }
        
        priceFound = true;
      } 
      // 2. 如果没有价格信息，尝试从PriceMonitor获取
      else if (this.priceMonitor && this.priceMonitor.currentPrice > 0) {
        const currentPrice = this.priceMonitor.currentPrice;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: 监控模块)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: '监控模块',
          updateTime: this.priceMonitor.lastUpdateTime || Date.now()
        };
        
        priceFound = true;
      } 
      // 3. 如果仍然没有价格，尝试从WebSocketManager直接获取
      else if (this.priceMonitor && this.priceMonitor.wsManager && 
              this.priceMonitor.wsManager.lastPriceData && 
              this.priceMonitor.wsManager.lastPriceData.price > 0) {
        
        const wsPrice = this.priceMonitor.wsManager.lastPriceData;
        const currentPrice = wsPrice.price;
        priceInfo = `${currentPrice.toFixed(1)} USDC (来源: WebSocket直接获取)`;
        
        // 更新到应用状态
        this.currentPriceInfo = {
          price: currentPrice,
          source: 'WebSocket直接获取',
          updateTime: wsPrice.time || Date.now()
        };
        
        priceFound = true;
      }
      // 4. 尝试从API获取最新价格
      else if (!priceFound) {
        try {
          this.backpackService.getTicker(this.symbol)
            .then(ticker => {
              if (ticker && ticker.lastPrice) {
                const apiPrice = parseFloat(ticker.lastPrice);
                // 只更新状态，不直接影响当前显示
                this.currentPriceInfo = {
                  price: apiPrice,
                  source: 'API请求',
                  updateTime: Date.now()
                };
                
                // 在下一次调用displayAccountInfo时会使用这个价格
                log(`从API获取到价格: ${apiPrice} USDC`);
              }
            })
            .catch(error => {
              log(`API获取价格失败: ${error.message}`);
            });
        } catch (apiError) {
          // 如果API请求失败，静默处理
        }
      }
      
      // 如果找到了价格数据并且有成交均价，计算涨跌幅和进度
      if (priceFound && this.tradeStats.averagePrice > 0) {
        const currentPrice = this.currentPriceInfo.price;
        // 计算涨跌幅
        const priceChange = ((currentPrice - this.tradeStats.averagePrice) / this.tradeStats.averagePrice) * 100;
        this.currentPriceInfo.increase = priceChange;
        
        const absChange = Math.abs(priceChange).toFixed(2);
        priceChangeSymbol = priceChange >= 0 ? "↑" : "↓";
        
        // 计算离止盈目标的进度百分比
        if (priceChange > 0 && takeProfitPercentage > 0) {
          percentProgress = this.tradingStrategy.calculateProgressPercentage(
            currentPrice, 
            this.tradeStats.averagePrice, 
            takeProfitPercentage
          ).toFixed(0);
        }
      }
      
      // 计算盈亏情况
      let currentValue = 0;
      let profit = 0;
      let profitPercent = 0;
      
      if (this.tradeStats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && this.tradeStats.totalFilledQuantity > 0) {
        currentValue = this.currentPriceInfo.price * this.tradeStats.totalFilledQuantity;
        profit = currentValue - this.tradeStats.totalFilledAmount;
        profitPercent = profit / this.tradeStats.totalFilledAmount * 100;
      }
      
      // 格式化并显示
      const data = {
        timeNow,
        symbol: this.symbol,
        scriptStartTime: this.scriptStartTime.toLocaleString(),
        elapsedTime,
        wsStatusInfo,
        priceInfo,
        priceChangeSymbol,
        increase: this.currentPriceInfo?.increase || 0,
        takeProfitPercentage,
        percentProgress,
        stats: this.tradeStats,
        tradingCoin: this.tradingCoin,
        currentValue,
        profit,
        profitPercent,
        priceSource: this.currentPriceInfo?.source
      };
      
      // 格式化并显示
      const display = Formatter.formatAccountInfo(data);
      console.clear();
      console.log(display);
      
      this.displayInitialized = true;
    } catch (error) {
      // 如果显示过程出错，回退到简单显示
      log(`显示信息时发生错误: ${error.message}`);
      // 简单显示函数
      console.log(`\n价格: ${this.currentPriceInfo?.price || '未知'} USDC`);
      console.log(`订单: ${this.tradeStats.filledOrders}/${this.tradeStats.totalOrders}`);
      console.log(`错误: ${error.message}`);
    }
  }
  
  /**
   * 显示统计信息
   */
  displayStats() {
    const stats = this.tradeStats;
    
    log('\n=== 订单统计信息 ===');
    log(`总挂单次数: ${stats.totalOrders}`);
    log(`已成交订单: ${stats.filledOrders}`);
    log(`总成交金额: ${stats.totalFilledAmount.toFixed(2)} USDC`);
    log(`总成交数量: ${stats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
    log(`平均成交价格: ${stats.averagePrice.toFixed(2)} USDC`);
    
    // 计算并显示盈亏情况
    if (stats.filledOrders > 0 && this.currentPriceInfo && this.currentPriceInfo.price && stats.totalFilledQuantity > 0) {
      const currentPrice = this.currentPriceInfo.price;
      const currentValue = currentPrice * stats.totalFilledQuantity;
      const cost = stats.totalFilledAmount;
      const profit = currentValue - cost;
      const profitPercent = (profit / cost * 100);
      
      // 获取当前价格相对于平均价格的涨跌幅
      const priceChange = ((currentPrice - stats.averagePrice) / stats.averagePrice) * 100;
      
      // 计算达到止盈目标的进度
      const takeProfitPercentage = this.config.trading.takeProfitPercentage;
      let takeProfitProgress = '0%';
      
      if (priceChange > 0 && takeProfitPercentage > 0) {
        takeProfitProgress = `${Math.min(100, (priceChange / takeProfitPercentage * 100)).toFixed(0)}%`;
      }
      
      // 添加颜色指示和箭头符号
      const priceChangeSymbol = priceChange >= 0 ? '↑' : '↓';
      const profitSymbol = profit >= 0 ? '↑' : '↓';
      
      log(`当前市场价格: ${currentPrice.toFixed(2)} USDC`);
      log(`价格涨跌幅: ${priceChangeSymbol} ${Math.abs(priceChange).toFixed(2)}%`);
      log(`距离止盈目标: ${takeProfitPercentage}% (已完成: ${takeProfitProgress})`);
      log(`当前持仓价值: ${currentValue.toFixed(2)} USDC`);
      log(`盈亏金额: ${profitSymbol} ${Math.abs(profit).toFixed(2)} USDC`);
      log(`盈亏百分比: ${profitSymbol} ${Math.abs(profitPercent).toFixed(2)}%`);
      
      // 添加数据来源信息
      if (this.currentPriceInfo.source) {
        log(`价格数据来源: ${this.currentPriceInfo.source}`);
      }
      
      // 显示数据更新时间
      if (this.currentPriceInfo.updateTime) {
        const updateTime = new Date(this.currentPriceInfo.updateTime);
        const dataAge = Math.floor((Date.now() - updateTime) / 1000);
        log(`价格更新时间: ${updateTime.toLocaleTimeString()} (${dataAge}秒前)`);
      }
    } else if (stats.filledOrders === 0) {
      log(`尚无成交订单，无法计算盈亏情况`);
    } else if (!this.currentPriceInfo || !this.currentPriceInfo.price) {
      log(`无法获取当前价格，无法计算盈亏情况`);
    }
    
    log(`统计数据最后更新: ${stats.lastUpdateTime ? stats.lastUpdateTime.toLocaleString() : '无'}`);
    log(`已处理订单数量: ${stats.processedOrderIds ? stats.processedOrderIds.size : 0}`);
    log('==================\n');
  }
  
  /**
   * 恢复历史订单数据（修复重启后数据丢失问题）
   */
  async loadHistoricalOrders() {
    try {
      log('正在恢复历史订单数据...');
      
      // 查询历史订单（增加到7天内的订单）
      const historicalOrders = await this.backpackService.getOrderHistory(this.symbol, 200);
      
      if (!historicalOrders || historicalOrders.length === 0) {
        log('未找到历史订单记录');
        return;
      }
      
      log(`获取到 ${historicalOrders.length} 个历史订单记录`);
      
      // 筛选已成交的买单 - 支持多种订单类型和交易对格式
      const filledBuyOrders = historicalOrders.filter(order => {
        const isFilledStatus = order.status === 'Filled' || order.status === 'filled';
        const isBuyOrder = order.side === 'Bid' || order.side === 'Buy' || order.side === 'BUY' || order.side === 'bid' || order.side === 'buy';
        const isCorrectSymbol = order.symbol === this.symbol || 
                               order.symbol === this.symbol.replace('_USD', '/USD') ||
                               order.symbol === this.symbol.replace('_USDC', '/USDC') ||
                               order.symbol === this.symbol.replace('_', '/');
        
        if (isFilledStatus && isBuyOrder && isCorrectSymbol) {
          log(`✅ 找到买单: ${order.id} - ${order.side} ${order.orderType || order.type || 'Unknown'} ${order.quantity} @ ${order.price}`);
        }
        
        return isFilledStatus && isBuyOrder && isCorrectSymbol;
      });
      
      if (filledBuyOrders.length === 0) {
        log('未找到已成交的买单');
        return;
      }
      
      log(`找到 ${filledBuyOrders.length} 个已成交的买单`);
      
             // 按时间排序（最新的在前）
       filledBuyOrders.sort((a, b) => {
         const timeA = new Date(a.timestamp || a.createTime || 0).getTime();
         const timeB = new Date(b.timestamp || b.createTime || 0).getTime();
         return timeB - timeA;
       });
       
       // 将历史订单添加到本地管理器
       let recoveredCount = 0;
       let skippedCount = 0;
       
       for (const historyOrder of filledBuyOrders) {
         try {
           // 检查是否已经存在此订单
           if (this.orderManager.getOrder(historyOrder.id)) {
             skippedCount++;
             continue;
           }
           
           // 验证订单数据完整性
           const price = parseFloat(historyOrder.price);
           const quantity = parseFloat(historyOrder.quantity);
           const filledQuantity = parseFloat(historyOrder.filledQuantity || historyOrder.quantity);
           
           if (isNaN(price) || isNaN(quantity) || isNaN(filledQuantity) || 
               price <= 0 || quantity <= 0 || filledQuantity <= 0) {
             log(`跳过无效订单数据: ${historyOrder.id} - price=${historyOrder.price}, quantity=${historyOrder.quantity}`, true);
             skippedCount++;
             continue;
           }
           
           // 创建订单对象
           const order = new Order({
             id: historyOrder.id,
             symbol: historyOrder.symbol,
             side: historyOrder.side,
             price: price,
             quantity: quantity,
             filledQuantity: filledQuantity,
             filledAmount: parseFloat(historyOrder.filledAmount || (price * filledQuantity)),
             status: 'Filled',
             createTime: new Date(historyOrder.timestamp || historyOrder.createTime || Date.now()),
             processed: false  // 标记为未处理，让统计系统处理
           });
           
           // 添加到订单管理器
           const added = this.orderManager.addOrder(order);
           if (!added) {
             log(`添加订单到管理器失败: ${historyOrder.id}`, true);
             skippedCount++;
             continue;
           }
           
           // 更新统计数据
           const updated = this.tradeStats.updateStats(order);
           if (updated) {
             recoveredCount++;
             const orderTime = new Date(historyOrder.timestamp || historyOrder.createTime || Date.now()).toLocaleString();
             log(`恢复订单: ${historyOrder.id} - ${order.filledQuantity.toFixed(6)} ${this.tradingCoin} @ ${order.price.toFixed(2)} USDC (${orderTime})`);
           } else {
             log(`更新统计数据失败: ${historyOrder.id}`, true);
             skippedCount++;
           }
           
         } catch (orderError) {
           log(`处理历史订单失败 ${historyOrder.id}: ${orderError.message}`, true);
           skippedCount++;
         }
       }
      
             // 显示恢复结果
       log(`\n===== 历史订单恢复完成 =====`);
       log(`总历史订单: ${filledBuyOrders.length}`);
       log(`成功恢复: ${recoveredCount}`);
       log(`跳过订单: ${skippedCount}`);
       
       if (recoveredCount > 0) {
         log(`总成交金额: ${this.tradeStats.totalFilledAmount.toFixed(2)} USDC`);
         log(`总成交数量: ${this.tradeStats.totalFilledQuantity.toFixed(6)} ${this.tradingCoin}`);
         log(`平均成交价: ${this.tradeStats.averagePrice.toFixed(2)} USDC`);
         log(`完成订单数: ${this.tradeStats.filledOrders}`);
         
         // 计算修正后的止盈价格
         const takeProfitPercentage = this.config.trading?.takeProfitPercentage || 0.6;
         const takeProfitPrice = this.tradeStats.averagePrice * (1 + takeProfitPercentage / 100);
         log(`修正后止盈价格: ${takeProfitPrice.toFixed(2)} USDC (${takeProfitPercentage}%)`);
       } else {
         log('未恢复任何历史订单数据');
       }
       log('================================\n');
      
    } catch (error) {
      log(`恢复历史订单数据失败: ${error.message}`, true);
      // 不抛出错误，让系统继续运行
    }
  }
  
  /**
   * 重置应用状态
   */
  resetAppState() {
    log('\n===== 重置应用状态 =====');
    
    // 🎲 马丁格尔策略：如果不是止盈重启，则视为亏损，增加投资金额
    if (this.martingaleEnabled && this.lastTradeResult !== 'profit') {
      this.handleMartingaleLoss();
    }
    
    // 重置全局配置的一些状态 - 确保统一重置
    this.scriptStartTime = new Date();
    this.tradeStats.reset();
    this.orderManager.reset();
    
    // 确保订单管理服务也使用重置后的实例
    if (this.orderManagerService) {
      this.orderManagerService.orderManager = this.orderManager;
      this.orderManagerService.tradeStats = this.tradeStats;
    }
    
    // 重新初始化对账服务，确保使用重置后的统计实例
    if (this.reconciliationService) {
      this.reconciliationService.tradeStats = this.tradeStats;
    }
    
    // 确保WebSocket资源被正确清理
    if (this.priceMonitor && this.priceMonitor.wsManager) {
      log('清理WebSocket资源...');
      try {
        // 检查是否需要先停止监控
        if (this.priceMonitor.monitoring) {
          this.priceMonitor.stopMonitoring();
        }
        
        // 额外确保WebSocket连接关闭
        if (this.priceMonitor.wsManager) {
          this.priceMonitor.wsManager.closeAllConnections();
        }
      } catch (error) {
        log(`清理WebSocket资源时出错: ${error.message}`, true);
      }
    }
    
    // 重置监控状态
    this.takeProfitTriggered = false;
    this.currentPriceInfo = null;
    this.displayInitialized = false;
    this.cycleLogFile = this.logger.createCycleLogFile();
    
    log('已完全重置所有订单记录和统计数据');
  }
  
  /**
   * 是否达到止盈条件
   */
  isTakeProfitTriggered() {
    return this.takeProfitTriggered;
  }
  
  /**
   * 检查应用是否正在运行
   */
  isRunning() {
    return this.running;
  }
  
  /**
   * 检查是否需要重启 (此方法已不再使用，保留为了向后兼容)
   * @deprecated 已弃用，现在使用内部状态重置代替重启
   * @returns {boolean} 永远返回false
   */
  isRestartNeeded() {
    return false; // 永远返回false，因为我们不再使用重启机制
  }
}

module.exports = TradingApp; 