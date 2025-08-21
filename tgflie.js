// 优化版本 - 移除文件大小限制，纯白页面，优化登录逻辑，美化界面

// 数据库初始化函数
async function initDatabase(config) {
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        url TEXT PRIMARY KEY,
        fileId TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT
      )
    `).run();
  }
  
  // 导出函数
  export default {
    async fetch(request, env) {
      // 环境变量配置
      const config = {
        domain: env.DOMAIN,
        database: env.DATABASE,
        username: env.USERNAME,
        password: env.PASSWORD,
        enableAuth: env.ENABLE_AUTH === 'true',
        tgBotToken: env.TG_BOT_TOKEN,
        tgChatId: env.TG_CHAT_ID,
        cookie: Number(env.COOKIE) || 60 // cookie有效期默认为60天
      };
  
      // 初始化数据库
      await initDatabase(config);
      // 路由处理
      const { pathname } = new URL(request.url);
      
      const routes = {
        '/': () => handleAuthRequest(request, config),
        '/login': () => handleLoginRequest(request, config),
        '/upload': () => handleUploadRequest(request, config),
        '/admin': () => handleAdminRequest(request, config),
        '/delete': () => handleDeleteRequest(request, config),
        '/search': () => handleSearchRequest(request, config)
      };
      
      const handler = routes[pathname];
      if (handler) {
        return await handler();
      }
      // 处理文件访问请求
      return await handleFileRequest(request, config);
    }
  };
  
  // 处理身份认证
  function authenticate(request, config) {
    const cookies = request.headers.get("Cookie") || "";
    const authToken = cookies.match(/auth_token=([^;]+)/);
    
    if (authToken) {
      try {
        const tokenData = JSON.parse(atob(authToken[1]));
        const now = Date.now();
        
        if (now > tokenData.expiration) {
          console.log("Token已过期");
          return false;
        }
        
        return tokenData.username === config.username;
      } catch (error) {
        console.error("Token验证失败", error);
        return false;
      }
    }
    return false;
  }
  
  // 处理路由
  async function handleAuthRequest(request, config) {
    if (config.enableAuth) {
      const isAuthenticated = authenticate(request, config);
      if (!isAuthenticated) {
        return handleLoginRequest(request, config);
      }
      return handleUploadRequest(request, config);
    }
    return handleUploadRequest(request, config);
  }
  
  // 处理登录
  async function handleLoginRequest(request, config) {
    if (request.method === 'POST') {
      const { username, password } = await request.json();
      
      if (username === config.username && password === config.password) {
        const expirationDate = new Date();
        expirationDate.setDate(expirationDate.getDate() + config.cookie);
        const expirationTimestamp = expirationDate.getTime();
        
        const tokenData = JSON.stringify({
          username: config.username,
          expiration: expirationTimestamp
        });
  
        const token = btoa(tokenData);
        const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; Expires=${expirationDate.toUTCString()}`;
        
        return new Response("登录成功", {
          status: 200,
          headers: {
            "Set-Cookie": cookie,
            "Content-Type": "text/plain"
          }
        });
      }
      return new Response("认证失败", { status: 401 });
    }
    
    const html = generateLoginPage();
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
  
  // 处理文件上传
  async function handleUploadRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
      return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
    
    if (request.method === 'GET') {
      const html = generateUploadPage();
      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }
  
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) throw new Error('未找到文件');
      
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const mimeType = getContentType(ext);
      const [mainType] = mimeType.split('/');
      
      const typeMap = {
        image: { method: 'sendPhoto', field: 'photo' },
        video: { method: 'sendVideo', field: 'video' },
        audio: { method: 'sendAudio', field: 'audio' }
      };
      
      let { method = 'sendDocument', field = 'document' } = typeMap[mainType] || {};
  
      if (['application', 'text'].includes(mainType)) {
        method = 'sendDocument';
        field = 'document';
      }
  
      const tgFormData = new FormData();
      tgFormData.append('chat_id', config.tgChatId);
      tgFormData.append(field, file, file.name);
      
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${config.tgBotToken}/${method}`,
        { method: 'POST', body: tgFormData }
      ); 
      
      if (!tgResponse.ok) throw new Error('Telegram参数配置错误');
  
      const tgData = await tgResponse.json();
      const result = tgData.result;
      const messageId = result?.message_id;
      const fileId = result?.document?.file_id ||
                     result?.video?.file_id ||
                     result?.audio?.file_id ||
                    (result?.photo && result.photo[result.photo.length-1]?.file_id);
                    
      if (!fileId) throw new Error('未获取到文件ID');
      if (!messageId) throw new Error('未获取到tg消息ID');
  
      const time = Date.now();
      const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      const url = `https://${config.domain}/${time}.${ext}`;
      
      await config.database.prepare(`
        INSERT INTO files (url, fileId, message_id, created_at, file_name, file_size, mime_type) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        url,
        fileId,
        messageId,
        timestamp,
        file.name,
        file.size,
        file.type || getContentType(ext)
      ).run();
  
      return new Response(
        JSON.stringify({ status: 1, msg: "✓ 上传成功", url }),
        { headers: { 'Content-Type': 'application/json' }}
      );
  
    } catch (error) {
      console.error(`[Upload Error] ${error.message}`);
      
      let statusCode = 500;
      if (error.message.includes('Telegram参数配置错误')) {
        statusCode = 502;
      } else if (error.message.includes('未获取到文件ID') || error.message.includes('未获取到tg消息ID')) {
        statusCode = 500;
      } else if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        statusCode = 504;
      }
      
      return new Response(
        JSON.stringify({ status: 0, msg: "✗ 上传失败", error: error.message }),
        { status: statusCode, headers: { 'Content-Type': 'application/json' }}
      );
    }
  }
  
  // 处理文件管理和预览
  async function handleAdminRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
      return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
  
    const files = await config.database.prepare(
      `SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
      FROM files
      ORDER BY created_at DESC`
    ).all();
  
    const fileList = files.results || [];
    const fileCards = fileList.map(file => {
      const fileName = file.file_name;
      const fileSize = formatSize(file.file_size || 0);
      const createdAt = new Date(file.created_at).toISOString().replace('T', ' ').split('.')[0];
      
      return `
        <div class="file-card" data-url="${file.url}">
          <div class="file-preview">
            ${getPreviewHtml(file.url)}
          </div>
          <div class="file-info">
            <div class="file-name">${fileName}</div>
            <div class="file-meta">${fileSize} • ${createdAt}</div>
          </div>
          <div class="file-actions">
            <button class="btn btn-share" onclick="showQRCode('${file.url}')">分享</button>
            <a class="btn btn-download" href="${file.url}" download="${fileName}">下载</a>
            <button class="btn btn-delete" onclick="deleteFile('${file.url}')">删除</button>
          </div>
        </div>
      `;
    }).join('');
  
    const qrModal = `
      <div id="qrModal" class="qr-modal">
        <div class="qr-content">
          <div class="qr-header">分享文件</div>
          <div id="qrcode"></div>
          <div class="qr-buttons">
            <button class="btn btn-primary" onclick="handleCopyUrl()">复制链接</button>
            <button class="btn btn-secondary" onclick="closeQRModal()">关闭</button>
          </div>
        </div>
      </div>
    `;
  
    const html = generateAdminPage(fileCards, qrModal);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
  
  // 处理文件搜索
  async function handleSearchRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
      return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
  
    try {
      const { query } = await request.json();
      const searchPattern = `%${query}%`;
      
      const files = await config.database.prepare(
        `SELECT url, fileId, message_id, created_at, file_name, file_size, mime_type
         FROM files 
         WHERE file_name LIKE ? ESCAPE '!'
         COLLATE NOCASE
         ORDER BY created_at DESC`
      ).bind(searchPattern).all();
  
      return new Response(
        JSON.stringify({ files: files.results || [] }),
        { headers: { 'Content-Type': 'application/json' }}
      );
  
    } catch (error) {
      console.error(`[Search Error] ${error.message}`);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' }}
      );
    }
  }
  
  // 支持预览的文件类型
  function getPreviewHtml(url) {
    const ext = (url.split('.').pop() || '').toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'icon'].includes(ext);
    const isVideo = ['mp4', 'webm'].includes(ext);
    const isAudio = ['mp3', 'wav', 'ogg'].includes(ext);
  
    if (isImage) {
      return `<img src="${url}" alt="预览" loading="lazy">`;
    } else if (isVideo) {
      return `<video src="${url}" controls preload="metadata"></video>`;
    } else if (isAudio) {
      return `<audio src="${url}" controls preload="metadata"></audio>`;
    } else {
      return `<div class="file-icon">📄</div>`;
    }
  }
  
  // 获取文件并缓存
  async function handleFileRequest(request, config) {
    const url = request.url;
    const cache = caches.default;
    const cacheKey = new Request(url);
  
    try {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        console.log(`[Cache Hit] ${url}`);
        return cachedResponse;
      }
  
      const file = await config.database.prepare(
        `SELECT fileId, message_id, file_name, mime_type
        FROM files WHERE url = ?`
      ).bind(url).first();
  
      if (!file) {
        console.log(`[404] File not found: ${url}`);
        return new Response('文件不存在', { 
          status: 404,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
        });
      }
  
      const tgResponse = await fetch(
        `https://api.telegram.org/bot${config.tgBotToken}/getFile?file_id=${file.fileId}`
      );
  
      if (!tgResponse.ok) {
        console.error(`[Telegram API Error] ${await tgResponse.text()} for file ${file.fileId}`);
        return new Response('获取文件失败', { 
          status: 500,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
        });
      }
  
      const tgData = await tgResponse.json();
      const filePath = tgData.result?.file_path;
  
      if (!filePath) {
        console.error(`[Invalid Path] No file_path in response for ${file.fileId}`);
        return new Response('文件路径无效', { 
          status: 404,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
        });
      }
  
      const fileUrl = `https://api.telegram.org/file/bot${config.tgBotToken}/${filePath}`;
      const fileResponse = await fetch(fileUrl);
  
      if (!fileResponse.ok) {
        console.error(`[Download Error] Failed to download from ${fileUrl}`);
        return new Response('下载文件失败', { 
          status: 500,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
        });
      }
  
      const contentType = file.mime_type || getContentType(url.split('.').pop().toLowerCase());
  
      const response = new Response(fileResponse.body, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.file_name || '')}`
        }
      });
  
      await cache.put(cacheKey, response.clone());
      console.log(`[Cache Set] ${url}`);
      return response;
  
    } catch (error) {
      console.error(`[Error] ${error.message} for ${url}`);
      return new Response('服务器内部错误', { 
        status: 500,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    }
  }
  
  // 处理文件删除
  async function handleDeleteRequest(request, config) {
    if (config.enableAuth && !authenticate(request, config)) {
      return Response.redirect(`${new URL(request.url).origin}/`, 302);
    }
  
    try {
      const { url } = await request.json();
      if (!url || typeof url !== 'string') {
        return new Response(JSON.stringify({ error: '无效的URL' }), {
          status: 400, 
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      const file = await config.database.prepare(
        'SELECT fileId, message_id FROM files WHERE url = ?'
      ).bind(url).first();
      
      if (!file) {
        return new Response(JSON.stringify({ error: '文件不存在' }), { 
          status: 404, 
          headers: { 'Content-Type': 'application/json' }
        });
      }
  
      let deleteError = null;
  
      try {
        const deleteResponse = await fetch(
          `https://api.telegram.org/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgChatId}&message_id=${file.message_id}`
        );
        if (!deleteResponse.ok) {
          const errorData = await deleteResponse.json();
          console.error(`[Telegram API Error] ${JSON.stringify(errorData)}`);
          throw new Error(`Telegram 消息删除失败: ${errorData.description}`);
        }
      } catch (error) { 
        deleteError = error.message; 
      }
  
      await config.database.prepare('DELETE FROM files WHERE url = ?').bind(url).run();
      
      return new Response(
        JSON.stringify({ 
          success: true,
          message: deleteError ? `文件已从数据库删除，但Telegram消息删除失败: ${deleteError}` : '文件删除成功'
        }),
        { headers: { 'Content-Type': 'application/json' }}
      );
  
    } catch (error) {
      console.error(`[Delete Error] ${error.message}`);
      return new Response(
        JSON.stringify({ 
          error: error.message.includes('message to delete not found') ? 
                '文件已从频道移除' : error.message 
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' }}
      );
    }
  }
  
  // 支持上传的文件类型
  function getContentType(ext) {
    const types = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg', 
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      icon: 'image/x-icon',
      mp4: 'video/mp4',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      zip: 'application/zip',
      rar: 'application/x-rar-compressed',
      json: 'application/json',
      xml: 'application/xml',
      ini: 'text/plain',
      js: 'application/javascript',
      yml: 'application/yaml',
      yaml: 'application/yaml',
      py: 'text/x-python',
      sh: 'application/x-sh'
    };
    return types[ext] || 'application/octet-stream';
  }
  
  // 文件大小计算函数
  function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
  
  // 登录页面生成函数 /login
  function generateLoginPage() {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>登录 - Telegram文件存储</title>
      <link rel="shortcut icon" href="https://pan.811520.xyz/2025-02/1739241502-tgfile-favicon.ico" type="image/x-icon">
      <meta name="description" content="Telegram文件存储与分享平台">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        
        .login-container {
          background: white;
          padding: 2.5rem;
          border-radius: 16px;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
          width: 100%;
          max-width: 420px;
          position: relative;
          overflow: hidden;
        }
        
        .login-container::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 4px;
          background: linear-gradient(90deg, #667eea, #764ba2);
        }
        
        .logo {
          text-align: center;
          margin-bottom: 2rem;
        }
        
        .logo h1 {
          color: #1a202c;
          font-size: 1.875rem;
          font-weight: 700;
          margin-bottom: 0.5rem;
        }
        
        .logo p {
          color: #718096;
          font-size: 0.875rem;
        }
        
        .form-group {
          margin-bottom: 1.5rem;
          position: relative;
        }
        
        .form-group label {
          display: block;
          color: #4a5568;
          font-size: 0.875rem;
          font-weight: 500;
          margin-bottom: 0.5rem;
        }
        
        .form-group input {
          width: 100%;
          padding: 0.75rem 1rem;
          border: 2px solid #e2e8f0;
          border-radius: 8px;
          font-size: 1rem;
          transition: all 0.2s;
          background: #f7fafc;
        }
        
        .form-group input:focus {
          outline: none;
          border-color: #667eea;
          background: white;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .submit-btn {
          width: 100%;
          padding: 0.875rem;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          position: relative;
          overflow: hidden;
        }
        
        .submit-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }
        
        .submit-btn:active {
          transform: translateY(0);
        }
        
        .submit-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        
        .error-message {
          background: #fed7d7;
          color: #c53030;
          padding: 0.75rem;
          border-radius: 8px;
          font-size: 0.875rem;
          margin-top: 1rem;
          display: none;
          border-left: 4px solid #e53e3e;
        }
        
        .loading {
          display: none;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        }
        
        .spinner {
          width: 20px;
          height: 20px;
          border: 2px solid #ffffff40;
          border-top: 2px solid #ffffff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        .footer {
          text-align: center;
          margin-top: 2rem;
          padding-top: 1.5rem;
          border-top: 1px solid #e2e8f0;
        }
        
        .footer a {
          color: #667eea;
          text-decoration: none;
          font-size: 0.875rem;
        }
        
        .footer a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <div class="logo">
          <h1>🔐 登录验证</h1>
          <p>请输入您的凭据以访问文件存储</p>
        </div>
        
        <form id="loginForm">
          <div class="form-group">
            <label for="username">用户名</label>
            <input type="text" id="username" required autocomplete="username">
          </div>
          
          <div class="form-group">
            <label for="password">密码</label>
            <input type="password" id="password" required autocomplete="current-password">
          </div>
          
          <button type="submit" class="submit-btn" id="submitBtn">
            <span class="btn-text">登录</span>
            <div class="loading">
              <div class="spinner"></div>
            </div>
          </button>
          
          <div id="errorMessage" class="error-message">
            用户名或密码错误，请重试
          </div>
        </form>
        
        <div class="footer">
          <a href="https://github.com/yutian81/CF-tgfile" target="_blank">
            GitHub 项目地址
          </a>
        </div>
      </div>
  
      <script>
        const loginForm = document.getElementById('loginForm');
        const submitBtn = document.getElementById('submitBtn');
        const btnText = document.querySelector('.btn-text');
        const loading = document.querySelector('.loading');
        const errorMessage = document.getElementById('errorMessage');
  
        loginForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          
          const username = document.getElementById('username').value.trim();
          const password = document.getElementById('password').value;
          
          if (!username || !password) {
            showError('请填写完整的用户名和密码');
            return;
          }
          
          setLoading(true);
          hideError();
          
          try {
            const response = await fetch('/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username, password })
            });
            
            if (response.ok) {
              btnText.textContent = '登录成功，正在跳转...';
              setTimeout(() => {
                window.location.href = '/upload';
              }, 1000);
            } else {
              showError('用户名或密码错误，请重试');
            }
          } catch (err) {
            console.error('登录失败:', err);
            showError('网络连接失败，请稍后重试');
          } finally {
            setLoading(false);
          }
        });
        
        function setLoading(isLoading) {
          submitBtn.disabled = isLoading;
          if (isLoading) {
            btnText.style.opacity = '0';
            loading.style.display = 'block';
          } else {
            btnText.style.opacity = '1';
            loading.style.display = 'none';
            btnText.textContent = '登录';
          }
        }
        
        function showError(message) {
          errorMessage.textContent = message;
          errorMessage.style.display = 'block';
        }
        
        function hideError() {
          errorMessage.style.display = 'none';
        }
        
        // 自动聚焦到用户名输入框
        document.getElementById('username').focus();
      </script>
    </body>
    </html>`;
  }
  
  // 生成文件上传页面 /upload
  function generateUploadPage() {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>文件上传 - Telegram文件存储</title>
      <link rel="shortcut icon" href="https://pan.811520.xyz/2025-02/1739241502-tgfile-favicon.ico" type="image/x-icon">
      <meta name="description" content="Telegram文件存储与分享平台">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: #f8fafc;
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 900px;
          margin: 0 auto;
        }
        
        .header {
          background: white;
          padding: 2rem;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          margin-bottom: 2rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .header h1 {
          color: #1a202c;
          font-size: 1.875rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .admin-link {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 0.5rem 1rem;
          border-radius: 8px;
          text-decoration: none;
          font-weight: 500;
          transition: all 0.2s;
        }
        
        .admin-link:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        
        .upload-section {
          background: white;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          padding: 2rem;
          margin-bottom: 2rem;
        }
        
        .upload-area {
          border: 3px dashed #cbd5e0;
          padding: 3rem 2rem;
          text-align: center;
          border-radius: 12px;
          transition: all 0.3s ease;
          cursor: pointer;
          position: relative;
        }
        
        .upload-area:hover {
          border-color: #667eea;
          background: #f7fafc;
        }
        
        .upload-area.dragover {
          border-color: #667eea;
          background: #edf2f7;
          transform: scale(1.02);
        }
        
        .upload-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
          color: #a0aec0;
        }
        
        .upload-text {
          color: #4a5568;
          font-size: 1.125rem;
          margin-bottom: 0.5rem;
        }
        
        .upload-hint {
          color: #718096;
          font-size: 0.875rem;
        }
        
        .preview-section {
          background: white;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          padding: 2rem;
          margin-bottom: 2rem;
          display: none;
        }
        
        .preview-section.show {
          display: block;
        }
        
        .preview-header {
          font-size: 1.25rem;
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 1.5rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .preview-item {
          display: flex;
          align-items: center;
          padding: 1rem;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          margin-bottom: 1rem;
          transition: all 0.2s;
        }
        
        .preview-item:hover {
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        
        .preview-item img {
          max-width: 80px;
          max-height: 80px;
          border-radius: 8px;
          margin-right: 1rem;
          object-fit: cover;
        }
        
        .preview-info {
          flex-grow: 1;
          min-width: 0;
        }
        
        .preview-name {
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 0.25rem;
          word-break: break-all;
        }
        
        .preview-meta {
          color: #718096;
          font-size: 0.875rem;
        }
        
        .progress-bar {
          height: 8px;
          background: #edf2f7;
          border-radius: 4px;
          margin-top: 0.5rem;
          overflow: hidden;
          position: relative;
        }
        
        .progress-track {
          height: 100%;
          background: linear-gradient(90deg, #667eea, #764ba2);
          transition: width 0.3s ease;
          width: 0;
        }
        
        .progress-text {
          position: absolute;
          right: 0;
          top: -1.5rem;
          font-size: 0.75rem;
          color: #4a5568;
          font-weight: 500;
        }
        
        .success .progress-track {
          background: linear-gradient(90deg, #48bb78, #38a169);
        }
        
        .error .progress-track {
          background: linear-gradient(90deg, #f56565, #e53e3e);
        }
        
        .url-section {
          background: white;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          padding: 2rem;
        }
        
        .url-header {
          font-size: 1.25rem;
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 1.5rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .url-textarea {
          width: 100%;
          min-height: 120px;
          padding: 1rem;
          border: 2px solid #e2e8f0;
          border-radius: 12px;
          font-size: 0.875rem;
          font-family: 'Monaco', 'Menlo', monospace;
          background: #f7fafc;
          color: #2d3748;
          resize: vertical;
        }
        
        .url-textarea:focus {
          outline: none;
          border-color: #667eea;
          background: white;
        }
        
        .button-group {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-top: 1.5rem;
          flex-wrap: wrap;
          gap: 1rem;
        }
        
        .copy-buttons {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        
        .btn {
          padding: 0.5rem 1rem;
          border: none;
          border-radius: 8px;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
        }
        
        .btn-primary {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        
        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        
        .btn-secondary {
          background: #e2e8f0;
          color: #4a5568;
        }
        
        .btn-secondary:hover {
          background: #cbd5e0;
        }
        
        .copyright {
          color: #718096;
          font-size: 0.75rem;
        }
        
        .copyright a {
          color: #667eea;
          text-decoration: none;
        }
        
        .copyright a:hover {
          text-decoration: underline;
        }
        
        @media (max-width: 768px) {
          .header {
            flex-direction: column;
            gap: 1rem;
            text-align: center;
          }
          
          .button-group {
            flex-direction: column;
            align-items: stretch;
          }
          
          .copy-buttons {
            justify-content: center;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>📁 文件上传</h1>
          <a href="/admin" class="admin-link">管理文件</a>
        </div>
        
        <div class="upload-section">
          <div class="upload-area" id="uploadArea">
            <div class="upload-icon">☁️</div>
            <div class="upload-text">点击选择文件或拖拽到此处</div>
            <div class="upload-hint">支持所有文件类型，无大小限制</div>
            <input type="file" id="fileInput" multiple style="display: none">
          </div>
        </div>
        
        <div class="preview-section" id="previewSection">
          <div class="preview-header">
            📋 上传进度
          </div>
          <div id="previewArea"></div>
        </div>
        
        <div class="url-section">
          <div class="url-header">
            🔗 生成的链接
          </div>
          <textarea id="urlArea" class="url-textarea" readonly placeholder="上传完成后的链接将显示在这里..."></textarea>
          <div class="button-group">
            <div class="copy-buttons">
              <button class="btn btn-primary" onclick="copyUrls('url')">📋 复制URL</button>
              <button class="btn btn-primary" onclick="copyUrls('markdown')">📝 复制Markdown</button>
              <button class="btn btn-primary" onclick="copyUrls('html')">🌐 复制HTML</button>
            </div>
            <div class="copyright">
              © 2025 by <a href="https://github.com/yutian81/CF-tgfile" target="_blank">yutian81</a> | 
              <a href="https://blog.811520.xyz/" target="_blank">青云志</a>
            </div>
          </div>
        </div>
      </div>
  
      <script>
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        const previewArea = document.getElementById('previewArea');
        const previewSection = document.getElementById('previewSection');
        const urlArea = document.getElementById('urlArea');
        let uploadedUrls = [];
  
        // 拖拽事件处理
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
          uploadArea.addEventListener(eventName, preventDefaults, false);
          document.body.addEventListener(eventName, preventDefaults, false);
        });
  
        function preventDefaults(e) {
          e.preventDefault();
          e.stopPropagation();
        }
  
        ['dragenter', 'dragover'].forEach(eventName => {
          uploadArea.addEventListener(eventName, highlight, false);
        });
  
        ['dragleave', 'drop'].forEach(eventName => {
          uploadArea.addEventListener(eventName, unhighlight, false);
        });
  
        function highlight(e) {
          uploadArea.classList.add('dragover');
        }
  
        function unhighlight(e) {
          uploadArea.classList.remove('dragover');
        }
  
        uploadArea.addEventListener('drop', handleDrop, false);
        uploadArea.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', handleFiles);
  
        function handleDrop(e) {
          const dt = e.dataTransfer;
          const files = dt.files;
          handleFiles({ target: { files } });
        }
  
        // 粘贴上传
        document.addEventListener('paste', async (e) => {
          const items = (e.clipboardData || e.originalEvent.clipboardData).items;
          for (let item of items) {
            if (item.kind === 'file') {
              const file = item.getAsFile();
              await uploadFile(file);
            }
          }
        });
  
        async function handleFiles(e) {
          const files = Array.from(e.target.files);
          previewSection.classList.add('show');
          
          for (let file of files) {
            await uploadFile(file);
          }
        }
  
        async function uploadFile(file) {
          const preview = createPreview(file);
          previewArea.appendChild(preview);
  
          const xhr = new XMLHttpRequest();
          const progressTrack = preview.querySelector('.progress-track');
          const progressText = preview.querySelector('.progress-text');
  
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percent = Math.round((e.loaded / e.total) * 100);
              progressTrack.style.width = \`\${percent}%\`;
              progressText.textContent = \`\${percent}%\`;
            }
          });
  
          xhr.addEventListener('load', () => {
            try {
              const data = JSON.parse(xhr.responseText);
              
              if (xhr.status >= 200 && xhr.status < 300 && data.status === 1) {
                progressText.textContent = '✓ 上传完成';
                uploadedUrls.push(data.url);
                updateUrlArea();
                preview.classList.add('success');
              } else {
                const errorMsg = [data.msg, data.error || '未知错误'].filter(Boolean).join(' | ');
                progressText.textContent = \`✗ \${errorMsg}\`;
                preview.classList.add('error');
              }
            } catch (e) {
              progressText.textContent = '✗ 响应解析失败';
              preview.classList.add('error');
            }
          });
  
          xhr.addEventListener('error', () => {
            progressText.textContent = '✗ 网络错误';
            preview.classList.add('error');
          });
  
          const formData = new FormData();
          formData.append('file', file);
          xhr.open('POST', '/upload');
          xhr.send(formData);
        }
  
        function createPreview(file) {
          const div = document.createElement('div');
          div.className = 'preview-item';
          
          let previewContent = '';
          if (file.type.startsWith('image/')) {
            previewContent = \`<img src="\${URL.createObjectURL(file)}" alt="预览">\`;
          } else {
            previewContent = '<div class="file-icon">📄</div>';
          }
          
          div.innerHTML = \`
            \${previewContent}
            <div class="preview-info">
              <div class="preview-name">\${file.name}</div>
              <div class="preview-meta">\${formatSize(file.size)}</div>
              <div class="progress-bar">
                <div class="progress-track"></div>
                <span class="progress-text">0%</span>
              </div>
            </div>
          \`;
  
          return div;
        }
  
        function formatSize(bytes) {
          const units = ['B', 'KB', 'MB', 'GB', 'TB'];
          let size = bytes;
          let unitIndex = 0;
          while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
          }
          return \`\${size.toFixed(2)} \${units[unitIndex]}\`;
        }
  
        function updateUrlArea() {
          urlArea.value = uploadedUrls.join('\\n');
        }
  
        function copyUrls(format) {
          let text = '';
          switch (format) {
            case 'url':
              text = uploadedUrls.join('\\n');
              break;
            case 'markdown':
              text = uploadedUrls.map(url => \`![](\${url})\`).join('\\n');
              break;
            case 'html':
              text = uploadedUrls.map(url => \`<img src="\${url}" alt="image" />\`).join('\\n');
              break;
          }
          
          if (text) {
            navigator.clipboard.writeText(text).then(() => {
              // 显示复制成功提示
              const btn = event.target;
              const originalText = btn.textContent;
              btn.textContent = '✓ 已复制';
              btn.style.background = '#48bb78';
              
              setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '';
              }, 2000);
            }).catch(() => {
              alert('复制失败，请手动复制');
            });
          } else {
            alert('暂无链接可复制');
          }
        }
      </script>
    </body>
    </html>`;
  }
  
  // 生成文件管理页面 /admin
  function generateAdminPage(fileCards, qrModal) {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>文件管理 - Telegram文件存储</title>
      <link rel="shortcut icon" href="https://pan.811520.xyz/2025-02/1739241502-tgfile-favicon.ico" type="image/x-icon">
      <meta name="description" content="Telegram文件存储与分享平台">
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background: #f8fafc;
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
        }
        
        .header {
          background: white;
          padding: 2rem;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          margin-bottom: 2rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          flex-wrap: wrap;
          gap: 1rem;
        }
        
        .header h1 {
          color: #1a202c;
          font-size: 1.875rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .header-actions {
          display: flex;
          align-items: center;
          gap: 1rem;
        }
        
        .search-box {
          position: relative;
        }
        
        .search-input {
          padding: 0.75rem 1rem 0.75rem 2.5rem;
          border: 2px solid #e2e8f0;
          border-radius: 12px;
          width: 300px;
          font-size: 0.875rem;
          background: #f7fafc;
          transition: all 0.2s;
        }
        
        .search-input:focus {
          outline: none;
          border-color: #667eea;
          background: white;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }
        
        .search-icon {
          position: absolute;
          left: 0.75rem;
          top: 50%;
          transform: translateY(-50%);
          color: #a0aec0;
        }
        
        .back-link {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 0.75rem 1.5rem;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 500;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        
        .back-link:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 1.5rem;
        }
        
        .file-card {
          background: white;
          border-radius: 16px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
          overflow: hidden;
          transition: all 0.2s;
          border: 1px solid #e2e8f0;
        }
        
        .file-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
        }
        
        .file-preview {
          height: 100px;
          background: #f7fafc;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
        }
        
        .file-preview img, .file-preview video {
          max-width: 100%;
          max-height: 100%;
          object-fit: cover;
          border-radius: 0;
        }
        
        .file-preview audio {
          width: 90%;
          height: 40px;
        }
        
        .file-icon {
          font-size: 2rem;
          color: #a0aec0;
        }
        
        .file-info {
          padding: 1rem;
        }
        
        .file-name {
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 0.5rem;
          word-break: break-all;
          font-size: 0.875rem;
          line-height: 1.4;
        }
        
        .file-meta {
          color: #718096;
          font-size: 0.75rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .file-actions {
          padding: 1rem;
          border-top: 1px solid #e2e8f0;
          display: flex;
          gap: 0.5rem;
          justify-content: space-between;
        }
        
        .btn {
          padding: 0.5rem 0.75rem;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 0.75rem;
          font-weight: 500;
          transition: all 0.2s;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          flex: 1;
          justify-content: center;
        }
        
        .btn-share {
          background: #667eea;
          color: white;
        }
        
        .btn-share:hover {
          background: #5a67d8;
        }
        
        .btn-download {
          background: #48bb78;
          color: white;
        }
        
        .btn-download:hover {
          background: #38a169;
        }
        
        .btn-delete {
          background: #f56565;
          color: white;
        }
        
        .btn-delete:hover {
          background: #e53e3e;
        }
        
        .qr-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
          justify-content: center;
          align-items: center;
          z-index: 1000;
          backdrop-filter: blur(4px);
        }
        
        .qr-content {
          background: white;
          padding: 2rem;
          border-radius: 16px;
          text-align: center;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
          max-width: 90%;
          max-height: 90%;
        }
        
        .qr-header {
          font-size: 1.25rem;
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 1.5rem;
        }
        
        #qrcode {
          margin: 1rem 0;
          display: flex;
          justify-content: center;
        }
        
        .qr-buttons {
          display: flex;
          gap: 1rem;
          justify-content: center;
          margin-top: 1.5rem;
        }
        
        .btn-primary {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 8px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .btn-primary:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        
        .btn-secondary {
          background: #e2e8f0;
          color: #4a5568;
          padding: 0.75rem 1.5rem;
          border: none;
          border-radius: 8px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .btn-secondary:hover {
          background: #cbd5e0;
        }
        
        .empty-state {
          text-align: center;
          padding: 4rem 2rem;
          color: #718096;
        }
        
        .empty-state .icon {
          font-size: 4rem;
          margin-bottom: 1rem;
        }
        
        .empty-state h3 {
          font-size: 1.5rem;
          margin-bottom: 0.5rem;
          color: #4a5568;
        }
        
        @media (max-width: 768px) {
          .header {
            flex-direction: column;
            text-align: center;
          }
          
          .header-actions {
            width: 100%;
            justify-content: center;
          }
          
          .search-input {
            width: 100%;
            max-width: 300px;
          }
          
          .grid {
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          }
          
          .file-actions {
            flex-direction: column;
          }
          
          .qr-buttons {
            flex-direction: column;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🗂️ 文件管理</h1>
          <div class="header-actions">
            <div class="search-box">
              <span class="search-icon">🔍</span>
              <input type="text" class="search-input" placeholder="搜索文件名..." id="searchInput">
            </div>
            <a href="/upload" class="back-link">
              ⬅️ 返回上传
            </a>
          </div>
        </div>
        
        <div class="grid" id="fileGrid">
          ${fileCards || '<div class="empty-state"><div class="icon">📂</div><h3>暂无文件</h3><p>上传一些文件后，它们将显示在这里</p></div>'}
        </div>
        
        ${qrModal}
      </div>
  
      <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
      <script>
        const searchInput = document.getElementById('searchInput');
        const fileGrid = document.getElementById('fileGrid');
        const fileCards = Array.from(fileGrid.querySelectorAll('.file-card'));
  
        // 搜索功能
        searchInput.addEventListener('input', (e) => {
          const searchTerm = e.target.value.toLowerCase().trim();
          fileCards.forEach(card => {
            const fileName = card.querySelector('.file-name')?.textContent?.toLowerCase() || '';
            card.style.display = fileName.includes(searchTerm) ? '' : 'none';
          });
        });
  
        // 分享二维码功能
        let currentShareUrl = '';
        function showQRCode(url) {
          currentShareUrl = url;
          const modal = document.getElementById('qrModal');
          const qrcodeDiv = document.getElementById('qrcode');
          const copyBtn = modal.querySelector('.btn-primary');
          
          copyBtn.textContent = '📋 复制链接';
          copyBtn.disabled = false;
          qrcodeDiv.innerHTML = '';
          
          QRCode.toCanvas(qrcodeDiv, url, {
            width: 200,
            height: 200,
            color: {
              dark: '#000000',
              light: '#ffffff'
            },
            errorCorrectionLevel: 'H'
          });
          
          modal.style.display = 'flex';
        }
  
        function handleCopyUrl() {
          navigator.clipboard.writeText(currentShareUrl)
            .then(() => {
              const copyBtn = document.querySelector('#qrModal .btn-primary');
              copyBtn.textContent = '✓ 已复制';
              copyBtn.style.background = '#48bb78';
              
              setTimeout(() => {
                copyBtn.textContent = '📋 复制链接';
                copyBtn.style.background = '';
              }, 2000);
            })
            .catch(err => {
              console.error('复制失败:', err);
              alert('复制失败，请手动复制');
            });
        }
  
        function closeQRModal() {
          document.getElementById('qrModal').style.display = 'none';
        }
  
        // 点击模态框背景关闭
        window.onclick = function(event) {
          const modal = document.getElementById('qrModal');
          if (event.target === modal) {
            modal.style.display = 'none';
          }
        }
  
        // 删除文件功能
        async function deleteFile(url) {
          // 使用更美观的确认对话框
          if (!confirm('⚠️ 确定要删除这个文件吗？\n\n此操作不可撤销！')) return;
          
          // 找到对应的文件卡片并添加删除中的视觉反馈
          const card = document.querySelector(`[data-url="${url}"]`);
          if (card) {
            card.style.opacity = '0.5';
            card.style.pointerEvents = 'none';
          }
          
          try {
            const response = await fetch('/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url })
            });
  
            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(errorData.error || '删除失败');
            }
            
            // 删除成功，添加动画效果
            if (card) {
              card.style.transform = 'scale(0.8)';
              card.style.opacity = '0';
              setTimeout(() => {
                card.remove();
                // 检查是否还有文件，如果没有显示空状态
                if (fileGrid.children.length === 0) {
                  fileGrid.innerHTML = '<div class="empty-state"><div class="icon">📂</div><h3>暂无文件</h3><p>所有文件已被删除</p></div>';
                }
              }, 300);
            }
            
            // 显示成功提示
            showNotification('✅ 文件删除成功', 'success');
            
          } catch (error) {
            console.error('删除失败:', error);
            // 恢复卡片状态
            if (card) {
              card.style.opacity = '1';
              card.style.pointerEvents = 'auto';
            }
            showNotification('❌ 删除失败: ' + error.message, 'error');
          }
        }
        
        // 通知函数
        function showNotification(message, type = 'info') {
          const notification = document.createElement('div');
          notification.className = `notification ${type}`;
          notification.textContent = message;
          
          notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 1rem 1.5rem;
            background: ${type === 'success' ? '#48bb78' : type === 'error' ? '#f56565' : '#667eea'};
            color: white;
            border-radius: 12px;
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            z-index: 2000;
            font-weight: 500;
            transform: translateX(100%);
            transition: transform 0.3s ease;
          `;
          
          document.body.appendChild(notification);
          
          // 动画显示
          setTimeout(() => {
            notification.style.transform = 'translateX(0)';
          }, 100);
          
          // 自动消失
          setTimeout(() => {
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
              notification.remove();
            }, 300);
          }, 3000);
        }
        
        // ESC键关闭模态框
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            closeQRModal();
          }
        });
      </script>
    </body>
    </html>`;
  }