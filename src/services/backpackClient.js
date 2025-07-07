const crypto = require('crypto');
const axios = require('axios');
const nacl = require('tweetnacl');

/**
 * Backpack交易所API客户端
 * 使用ED25519签名算法
 */
class BackpackClient {
  constructor(privateKey, publicKey) {
    try {
      // 处理私钥格式
      if (privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) {
        // PEM格式私钥
        const privateKeyBuffer = Buffer.from(
          privateKey.replace(/-----BEGIN PRIVATE KEY-----|\-----END PRIVATE KEY-----|\n/g, ''),
          'base64'
        );
        // 提取32字节的ED25519私钥
        this.privateKey = new Uint8Array(privateKeyBuffer.slice(-32));
      } else if (privateKey.length === 64) {
        // 64字符hex格式
        this.privateKey = new Uint8Array(Buffer.from(privateKey, 'hex'));
      } else if (privateKey.length === 88) {
        // Base64格式
        this.privateKey = new Uint8Array(Buffer.from(privateKey, 'base64'));
      } else {
        throw new Error('私钥格式不支持');
      }
      
      this.publicKey = publicKey;
      this.baseURL = 'https://api.backpack.exchange';
      
      // 验证私钥长度
      if (this.privateKey.length !== 32) {
        throw new Error('私钥长度必须是32字节');
      }
      
    } catch (error) {
      throw new Error(`私钥处理错误: ${error.message}`);
    }
  }

  /**
   * 生成ED25519签名
   */
  sign(message) {
    try {
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.sign.detached(messageBytes, this.privateKey);
      return Buffer.from(signature).toString('base64');
    } catch (error) {
      throw new Error(`签名生成失败: ${error.message}`);
    }
  }

  /**
   * 构造签名消息
   */
  buildSignMessage(instruction, params = {}) {
    const timestamp = Date.now();
    const window = 5000;
    
    let message = `instruction=${instruction}&timestamp=${timestamp}&window=${window}`;
    
    // 添加参数到签名消息
    if (params && Object.keys(params).length > 0) {
      const sortedParams = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
      message += `&${sortedParams}`;
    }
    
    return { message, timestamp, window };
  }

  /**
   * 发送HTTP请求
   */
  async request(method, endpoint, params = {}) {
    try {
      const { message, timestamp, window } = this.buildSignMessage(endpoint, params);
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
        url: `${this.baseURL}${endpoint}`,
        headers,
        timeout: 30000,
      };

      if (method === 'GET' && Object.keys(params).length > 0) {
        config.params = params;
      } else if (method !== 'GET' && Object.keys(params).length > 0) {
        config.data = params;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`API请求失败: ${error.response.status} - ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        throw new Error('网络请求失败，请检查网络连接');
      } else {
        throw new Error(`请求配置错误: ${error.message}`);
      }
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
  async GetOpenOrders(params = {}) {
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
  async CancelOpenOrders(params = {}) {
    return this.request('DELETE', '/api/v1/orders', params);
  }

  /**
   * 获取订单历史
   */
  async OrderHistory(params = {}) {
    return this.request('GET', '/api/v1/history/orders', params);
  }

  /**
   * 获取成交历史
   */
  async FillHistory(params = {}) {
    return this.request('GET', '/api/v1/history/fills', params);
  }

  /**
   * 获取账户信息
   */
  async GetAccount() {
    return this.request('GET', '/api/v1/account');
  }

  /**
   * 获取交易对信息
   */
  async GetMarkets() {
    return this.request('GET', '/api/v1/markets');
  }
}

module.exports = { BackpackClient };