const crypto = require('crypto');
const axios = require('axios');

/**
 * Backpack交易所API客户端
 */
class BackpackClient {
  constructor(privateKey, publicKey) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.baseURL = 'https://api.backpack.exchange';
  }

  /**
   * 生成签名
   */
  sign(message) {
    return crypto.createHmac('sha256', this.privateKey).update(message).digest('hex');
  }

  /**
   * 发送HTTP请求
   */
  async request(method, endpoint, params = {}) {
    const timestamp = Date.now();
    const window = 5000;
    
    let queryString = '';
    if (method === 'GET' && Object.keys(params).length > 0) {
      queryString = '?' + new URLSearchParams(params).toString();
    }

    const instruction = `instruction=${endpoint}&timestamp=${timestamp}&window=${window}`;
    const message = method === 'GET' ? instruction : instruction + `&${JSON.stringify(params)}`;
    const signature = this.sign(message);

    const headers = {
      'X-API-Key': this.publicKey,
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'X-Window': window.toString(),
      'Content-Type': 'application/json',
    };

    const config = {
      method,
      url: `${this.baseURL}${endpoint}${queryString}`,
      headers,
    };

    if (method !== 'GET' && Object.keys(params).length > 0) {
      config.data = params;
    }

    try {
      const response = await axios(config);
      return response.data;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 获取行情数据
   */
  async Ticker(params) {
    return this.request('GET', '/api/v1/ticker', params);
  }

  /**
   * 获取账户余额
   */
  async Balance() {
    return this.request('GET', '/api/v1/capital');
  }

  /**
   * 获取未成交订单
   */
  async GetOpenOrders(params) {
    return this.request('GET', '/api/v1/orders', params);
  }

  /**
   * 获取订单详情
   */
  async GetOrder(params) {
    return this.request('GET', `/api/v1/order`, params);
  }

  /**
   * 创建订单
   */
  async ExecuteOrder(params) {
    return this.request('POST', '/api/v1/order', params);
  }

  /**
   * 取消订单
   */
  async CancelOrder(params) {
    return this.request('DELETE', '/api/v1/order', params);
  }

  /**
   * 取消所有订单
   */
  async CancelOpenOrders(params) {
    return this.request('DELETE', '/api/v1/orders', params);
  }

  /**
   * 获取订单历史
   */
  async OrderHistory(params) {
    return this.request('GET', '/api/v1/history/orders', params);
  }
}

module.exports = { BackpackClient };