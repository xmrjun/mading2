const { defaultLogger } = require('../utils/logger');

/**
 * API限流器 - 智能控制API调用频率，防止429错误
 * 支持优先级队列、熔断机制、动态退避策略
 */
class ApiLimiter {
  constructor(config = {}) {
    this.config = config;
    this.logger = config.logger || defaultLogger;
    
    // 限流配置
    this.limits = {
      requestsPerSecond: config.requestsPerSecond || 10,
      requestsPerMinute: config.requestsPerMinute || 100,
      burstLimit: config.burstLimit || 5, // 突发请求限制
      cooldownMs: config.cooldownMs || 60000 // 1分钟冷却期
    };
    
    // 请求队列 - 支持优先级
    this.queues = {
      critical: [],    // 关键操作：创建/取消订单
      normal: [],      // 正常操作：查询余额/订单状态  
      background: []   // 后台操作：历史数据/统计
    };
    
    // 限流状态
    this.state = {
      isLimited: false,
      limitStartTime: null,
      limitCount: 0,
      consecutiveLimits: 0,
      
      // 请求计数器
      requestsThisSecond: 0,
      requestsThisMinute: 0,
      lastSecondReset: Date.now(),
      lastMinuteReset: Date.now(),
      
      // 熔断状态
      circuitOpen: false,
      circuitOpenTime: null,
      circuitFailureCount: 0
    };
    
    // 统计信息
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitedRequests: 0,
      queuedRequests: 0,
      droppedRequests: 0,
      averageWaitTime: 0,
      circuitBreakerTrips: 0
    };
    
    // 处理队列的定时器
    this.processingInterval = null;
    this.isProcessing = false;
    
    // 启动队列处理
    this.startProcessing();
  }
  
  /**
   * 执行API调用 - 主要入口点
   * @param {Function} apiCall API调用函数
   * @param {Object} options 选项
   * @returns {Promise} API调用结果
   */
  async execute(apiCall, options = {}) {
    const priority = options.priority || 'normal';
    const timeout = options.timeout || 30000;
    const critical = options.critical || false;
    const retryable = options.retryable !== false;
    
    // 如果熔断器打开且不是关键请求，直接拒绝
    if (this.state.circuitOpen && !critical) {
      this.stats.droppedRequests++;
      throw new Error('API熔断器已打开，拒绝非关键请求');
    }
    
    // 创建请求对象
    const request = {
      id: Date.now() + Math.random(),
      apiCall,
      options: { priority, timeout, critical, retryable },
      createdAt: Date.now(),
      resolve: null,
      reject: null,
      attempts: 0,
      maxAttempts: retryable ? 3 : 1
    };
    
    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
      
      // 添加到相应优先级队列
      this.queues[priority].push(request);
      this.stats.queuedRequests++;
      
      // 设置超时
      setTimeout(() => {
        if (!request.completed) {
          request.completed = true;
          request.reject(new Error('API调用超时'));
          this.removeFromQueue(request);
        }
      }, timeout);
    });
  }
  
  /**
   * 启动队列处理
   */
  startProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    
    // 每100ms检查一次队列
    this.processingInterval = setInterval(() => {
      this.processQueue();
    }, 100);
  }
  
  /**
   * 处理请求队列
   */
  async processQueue() {
    if (this.isProcessing) return;
    
    // 更新计数器
    this.updateCounters();
    
    // 检查熔断器状态
    this.checkCircuitBreaker();
    
    // 如果正在限流或熔断器打开，延迟处理
    if (this.state.isLimited || this.state.circuitOpen) {
      return;
    }
    
    // 检查是否可以发送请求
    if (!this.canMakeRequest()) {
      return;
    }
    
    // 按优先级获取下一个请求
    const request = this.getNextRequest();
    if (!request) return;
    
    this.isProcessing = true;
    
    try {
      await this.executeRequest(request);
    } finally {
      this.isProcessing = false;
    }
  }
  
  /**
   * 检查是否可以发送请求
   */
  canMakeRequest() {
    const now = Date.now();
    
    // 检查每秒限制
    if (this.state.requestsThisSecond >= this.limits.requestsPerSecond) {
      return false;
    }
    
    // 检查每分钟限制
    if (this.state.requestsThisMinute >= this.limits.requestsPerMinute) {
      return false;
    }
    
    // 如果最近被限流，增加额外延迟
    if (this.state.limitStartTime && 
        now - this.state.limitStartTime < this.getLimitBackoffDelay()) {
      return false;
    }
    
    return true;
  }
  
  /**
   * 获取限流退避延迟
   */
  getLimitBackoffDelay() {
    // 基础延迟 + 指数退避
    const baseDelay = 1000; // 1秒
    const exponentialDelay = Math.min(
      baseDelay * Math.pow(2, this.state.consecutiveLimits - 1),
      60000 // 最大60秒
    );
    return exponentialDelay;
  }
  
  /**
   * 获取下一个待处理请求 - 按优先级
   */
  getNextRequest() {
    // 按优先级检查队列：critical -> normal -> background
    for (const priority of ['critical', 'normal', 'background']) {
      const queue = this.queues[priority];
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }
  
  /**
   * 执行单个请求
   */
  async executeRequest(request) {
    if (request.completed) return;
    
    const startTime = Date.now();
    request.attempts++;
    
    try {
      // 更新请求计数
      this.state.requestsThisSecond++;
      this.state.requestsThisMinute++;
      this.stats.totalRequests++;
      
      // 执行API调用
      const result = await request.apiCall();
      
      // 成功处理
      request.completed = true;
      request.resolve(result);
      
      this.stats.successfulRequests++;
      this.updateAverageWaitTime(Date.now() - request.createdAt);
      
      // 重置限流状态
      this.resetLimitState();
      
    } catch (error) {
      await this.handleRequestError(request, error, startTime);
    }
  }
  
  /**
   * 处理请求错误
   */
  async handleRequestError(request, error, startTime) {
    const is429Error = this.is429Error(error);
    
    if (is429Error) {
      // 处理429限流错误
      this.handleRateLimit(error);
      
      // 如果是可重试的请求且未超过最大尝试次数
      if (request.options.retryable && request.attempts < request.maxAttempts) {
        // 重新加入队列等待重试
        this.queues[request.options.priority].unshift(request);
        this.logger.log(`API请求被限流，将重试: ${request.id} (${request.attempts}/${request.maxAttempts})`);
        return;
      }
    } else {
      // 其他错误，增加熔断器失败计数
      this.state.circuitFailureCount++;
    }
    
    // 请求最终失败
    if (!request.completed) {
      request.completed = true;
      request.reject(error);
      
      this.logger.log(`API请求失败: ${error.message} (尝试${request.attempts}次)`, true);
    }
  }
  
  /**
   * 处理429限流
   */
  handleRateLimit(error) {
    this.state.isLimited = true;
    this.state.limitStartTime = Date.now();
    this.state.limitCount++;
    this.state.consecutiveLimits++;
    this.stats.rateLimitedRequests++;
    
    this.logger.log(`🚫 API被限流 (第${this.state.limitCount}次)，应用退避策略`, true);
    
    // 动态调整限制参数
    this.adjustLimitsAfterRateLimit();
    
    // 严重限流时打开熔断器
    if (this.state.consecutiveLimits >= 3) {
      this.openCircuitBreaker('连续限流过多');
    }
  }
  
  /**
   * 检查是否为429错误
   */
  is429Error(error) {
    return error.message.includes('429') ||
           error.message.includes('rate limit') ||
           error.message.includes('Rate Limit') ||
           error.message.includes('exceeded') ||
           (error.response && error.response.status === 429);
  }
  
  /**
   * 动态调整限制参数
   */
  adjustLimitsAfterRateLimit() {
    // 减少请求频率
    this.limits.requestsPerSecond = Math.max(
      Math.floor(this.limits.requestsPerSecond * 0.8),
      1
    );
    
    this.limits.requestsPerMinute = Math.max(
      Math.floor(this.limits.requestsPerMinute * 0.8),
      10
    );
    
    this.logger.log(`📉 降低API频率限制: ${this.limits.requestsPerSecond}/秒, ${this.limits.requestsPerMinute}/分钟`);
  }
  
  /**
   * 重置限流状态
   */
  resetLimitState() {
    if (this.state.isLimited) {
      this.state.isLimited = false;
      this.state.consecutiveLimits = 0;
      this.logger.log('✅ API限流状态已重置');
      
      // 逐步恢复请求频率
      this.graduallyIncreaseLimit();
    }
    
    // 重置熔断器失败计数
    this.state.circuitFailureCount = 0;
  }
  
  /**
   * 逐步恢复请求频率
   */
  graduallyIncreaseLimit() {
    const originalLimits = {
      requestsPerSecond: this.config.requestsPerSecond || 10,
      requestsPerMinute: this.config.requestsPerMinute || 100
    };
    
    // 缓慢恢复到原始限制
    if (this.limits.requestsPerSecond < originalLimits.requestsPerSecond) {
      this.limits.requestsPerSecond = Math.min(
        this.limits.requestsPerSecond + 1,
        originalLimits.requestsPerSecond
      );
    }
    
    if (this.limits.requestsPerMinute < originalLimits.requestsPerMinute) {
      this.limits.requestsPerMinute = Math.min(
        this.limits.requestsPerMinute + 5,
        originalLimits.requestsPerMinute
      );
    }
  }
  
  /**
   * 检查熔断器状态
   */
  checkCircuitBreaker() {
    const now = Date.now();
    
    // 如果熔断器打开超过冷却时间，尝试半开状态
    if (this.state.circuitOpen && 
        this.state.circuitOpenTime && 
        now - this.state.circuitOpenTime > this.limits.cooldownMs) {
      
      this.logger.log('🔄 熔断器进入半开状态，尝试恢复');
      this.state.circuitOpen = false;
      this.state.circuitFailureCount = 0;
    }
  }
  
  /**
   * 打开熔断器
   */
  openCircuitBreaker(reason) {
    if (!this.state.circuitOpen) {
      this.state.circuitOpen = true;
      this.state.circuitOpenTime = Date.now();
      this.stats.circuitBreakerTrips++;
      
      this.logger.log(`⚡ 熔断器已打开: ${reason}`, true);
      
      // 清空非关键请求队列
      this.clearNonCriticalRequests();
    }
  }
  
  /**
   * 清空非关键请求队列
   */
  clearNonCriticalRequests() {
    let droppedCount = 0;
    
    ['normal', 'background'].forEach(priority => {
      const queue = this.queues[priority];
      while (queue.length > 0) {
        const request = queue.pop();
        if (!request.completed) {
          request.completed = true;
          request.reject(new Error('熔断器已打开，丢弃非关键请求'));
          droppedCount++;
        }
      }
    });
    
    this.stats.droppedRequests += droppedCount;
    this.logger.log(`🗑️ 丢弃了${droppedCount}个非关键请求`);
  }
  
  /**
   * 更新计数器
   */
  updateCounters() {
    const now = Date.now();
    
    // 重置每秒计数器
    if (now - this.state.lastSecondReset >= 1000) {
      this.state.requestsThisSecond = 0;
      this.state.lastSecondReset = now;
    }
    
    // 重置每分钟计数器
    if (now - this.state.lastMinuteReset >= 60000) {
      this.state.requestsThisMinute = 0;
      this.state.lastMinuteReset = now;
    }
  }
  
  /**
   * 更新平均等待时间
   */
  updateAverageWaitTime(waitTime) {
    this.stats.averageWaitTime = (this.stats.averageWaitTime + waitTime) / 2;
  }
  
  /**
   * 从队列中移除请求
   */
  removeFromQueue(request) {
    Object.values(this.queues).forEach(queue => {
      const index = queue.findIndex(r => r.id === request.id);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    });
  }
  
  /**
   * 获取限流器状态
   */
  getStatus() {
    const queueSizes = {
      critical: this.queues.critical.length,
      normal: this.queues.normal.length,
      background: this.queues.background.length,
      total: this.queues.critical.length + this.queues.normal.length + this.queues.background.length
    };
    
    return {
      limits: { ...this.limits },
      state: { ...this.state },
      stats: { ...this.stats },
      queues: queueSizes,
      health: {
        healthy: !this.state.circuitOpen && !this.state.isLimited,
        limitBackoffMs: this.state.isLimited ? this.getLimitBackoffDelay() : 0,
        circuitOpenMs: this.state.circuitOpen ? Date.now() - this.state.circuitOpenTime : 0
      }
    };
  }
  
  /**
   * 强制重置限流器
   */
  forceReset() {
    this.state.isLimited = false;
    this.state.circuitOpen = false;
    this.state.limitStartTime = null;
    this.state.circuitOpenTime = null;
    this.state.consecutiveLimits = 0;
    this.state.circuitFailureCount = 0;
    
    this.logger.log('🔄 API限流器已强制重置');
  }
  
  /**
   * 停止处理
   */
  stop() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    
    // 拒绝所有待处理请求
    Object.values(this.queues).forEach(queue => {
      while (queue.length > 0) {
        const request = queue.pop();
        if (!request.completed) {
          request.completed = true;
          request.reject(new Error('API限流器已停止'));
        }
      }
    });
    
    this.logger.log('API限流器已停止');
  }
}

module.exports = ApiLimiter;