export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Login endpoint
    if (path === '/login' && request.method === 'POST') { 
      try {
        // Accept JSON or form-encoded bodies; be tolerant to content-type differences
        let password;
        const ct = request.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          try {
            const body = await request.json();
            password = body && body.password;
          } catch (e) {
            // fallthrough to try text
          }
        }
        if (typeof password === 'undefined') {
          if (ct.includes('application/x-www-form-urlencoded')) {
            const txt = await request.text();
            const params = new URLSearchParams(txt);
            password = params.get('password');
          } else {
            // attempt to parse text as json or raw
            const txt = await request.text();
            try {
              const parsed = JSON.parse(txt);
              password = parsed && parsed.password;
            } catch (e) {
              // last resort: treat entire body as password
              if (txt && txt.trim()) {
                password = txt.trim();
              }
            }
          }
        }
        
        // If server PASSWORD is not configured, return a clear error message
        if (!env.PASSWORD) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'Server password not configured. 请在 Cloudflare Worker 的环境变量中设置 PASSWORD。' 
          }), {
            status: 500,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }

        if (password === env.PASSWORD) {
          const token = btoa(Date.now() + ':' + Math.random());
          return new Response(JSON.stringify({ 
            success: true, 
            token: token 
          }), {
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        } else {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'Invalid password' 
          }), {
            status: 401,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Invalid request' 
        }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    // Verify authentication for protected routes
    if (path !== '/' && path !== '/login' && !path.startsWith('/s/')) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Unauthorized' 
        }), {
          status: 401,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    // Serve direct content links (public, no authentication required)
    if (path.startsWith('/s/')) {
      const clipId = path.substring(3);
      try {
        const data = await env.JTB.get(clipId);
        if (data) {
          const clipData = JSON.parse(data);
          return new Response(clipData.content, {
            headers: { 
              'Content-Type': 'text/plain; charset=utf-8',
              ...corsHeaders 
            }
          });
        } else {
          return new Response('Content not found', { 
            status: 404,
            headers: corsHeaders 
          });
        }
      } catch (error) {
        return new Response('Error fetching content', {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    // Generate unique ID
    function generateId() {
      return Math.random().toString(36).substr(2, 9);
    }

    // Get preview function
    function getPreview(content, maxLines) {
      if (!content) return '';
      const lines = content.split('\n');
      const previewLines = lines.slice(0, maxLines);
      let preview = previewLines.join('\n');
      if (lines.length > maxLines) {
        preview += '...';
      }
      return preview;
    }

    // API Routes
    if (path === '/api/save' && request.method === 'POST') {
      try {
        const { content, id } = await request.json();
        const clipId = id || generateId();
        
        const clipData = {
          id: clipId,
          content: content,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        await env.JTB.put(clipId, JSON.stringify(clipData));
        
        return new Response(JSON.stringify({
          success: true,
          id: clipId,
          url: `${url.origin}/s/${clipId}`,
          editUrl: `${url.origin}/${clipId}`
        }), {
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Error saving content' 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    if (path === '/api/list' && request.method === 'GET') {
      try {
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = 20;
        const { keys } = await env.JTB.list();
        const clips = [];
        
        for (const key of keys) {
          const data = await env.JTB.get(key.name);
          if (data) {
            try {
              const clipData = JSON.parse(data);
              clips.push({
                id: clipData.id,
                content: clipData.content,
                preview: getPreview(clipData.content, 2),
                createdAt: clipData.createdAt,
                updatedAt: clipData.updatedAt,
                url: `${url.origin}/s/${clipData.id}`
              });
            } catch (e) {
              // Skip invalid JSON data
            }
          }
        }
        
        clips.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        
        const startIndex = (page - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        const paginatedClips = clips.slice(startIndex, endIndex);
        const totalPages = Math.ceil(clips.length / pageSize);
        
        return new Response(JSON.stringify({ 
          success: true, 
          clips: paginatedClips,
          currentPage: page,
          totalPages: totalPages,
          totalItems: clips.length
        }), {
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Error fetching clips' 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    if (path.startsWith('/api/get/') && request.method === 'GET') {
      const id = path.split('/')[3];
      try {
        const data = await env.JTB.get(id);
        if (data) {
          const clipData = JSON.parse(data);
          return new Response(JSON.stringify({ 
            success: true, 
            clip: clipData 
          }), {
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        } else {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'Clip not found' 
          }), {
            status: 404,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Error fetching clip' 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    if (path.startsWith('/api/delete/') && request.method === 'DELETE') {
      const id = path.split('/')[3];
      try {
        await env.JTB.delete(id);
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Clip deleted' 
        }), {
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Error deleting clip' 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    // Rename API endpoint
    if (path.startsWith('/api/rename/') && request.method === 'PUT') {
      const oldId = path.split('/')[3];
      try {
        const { newId } = await request.json();
        
        // Validate new ID
        if (!newId || newId.length < 1) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'New ID must be at least 1 character' 
          }), {
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }
        
        // Check if new ID already exists
        const existingData = await env.JTB.get(newId);
        if (existingData) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'New ID already exists' 
          }), {
            status: 409,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }
        
        // Get old data
        const oldData = await env.JTB.get(oldId);
        if (!oldData) {
          return new Response(JSON.stringify({ 
            success: false, 
            message: 'Original clip not found' 
          }), {
            status: 404,
            headers: { 
              'Content-Type': 'application/json',
              ...corsHeaders 
            }
          });
        }
        
        // Update the clip data with new ID
        const clipData = JSON.parse(oldData);
        clipData.id = newId;
        clipData.updatedAt = new Date().toISOString();
        
        // Save with new ID and delete old
        await env.JTB.put(newId, JSON.stringify(clipData));
        await env.JTB.delete(oldId);
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: 'Clip renamed successfully',
          newUrl: `${url.origin}/s/${newId}`,
          newEditUrl: `${url.origin}/${newId}`
        }), {
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Error renaming clip' 
        }), {
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders 
          }
        });
      }
    }

    // Serve HTML for root and clip URLs
    if (path === '/' || path.match(/^\/[a-zA-Z0-9\u4e00-\u9fff_-]+$/)) {
      return new Response(HTML_TEMPLATE, {
        headers: { 
          'Content-Type': 'text/html; charset=utf-8',
          ...corsHeaders 
        }
      });
    }

    return new Response('Not Found', { 
      status: 404,
      headers: corsHeaders 
    });
  }
};

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>在线剪贴板</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.2.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            min-height: 100vh;
        }

        .header {
            text-align: center;
            margin-bottom: 30px;
        }

        .header h1 {
            color: white;
            font-size: 2.5em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }

        .login-form, .main-content {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 15px;
            padding: 30px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.1);
            backdrop-filter: blur(10px);
        }

        .login-form {
            max-width: 400px;
            margin: 0 auto;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }

        .form-group input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #e1e8ed;
            border-radius: 8px;
            font-size: 16px;
            transition: border-color 0.3s;
        }

        .form-group input[type="password"]:focus {
            outline: none;
            border-color: #667eea;
        }

        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 16px;
            font-weight: 600;
            transition: all 0.3s;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }

        .btn-small {
            padding: 6px 12px;
            font-size: 12px;
            margin: 0 5px;
        }

        .editor-container {
            display: flex;
            gap: 20px;
            margin-bottom: 20px;
        }

        .editor-panel {
            flex: 1;
            background: #f8f9fa;
            border-radius: 10px;
            overflow: hidden;
            border: 2px solid #e9ecef;
        }

        .editor-header {
            background: #495057;
            color: white;
            padding: 10px 15px;
            font-weight: 600;
        }

        .line-numbers {
            background: #e9ecef;
            color: #6c757d;
            padding: 15px 10px;
            width: 50px;
            text-align: right;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 14px;
            line-height: 1.5;
            border-right: 1px solid #dee2e6;
            user-select: none;
            overflow-y: hidden;
            max-height: 400px;
            white-space: pre;
        }

        .editor-content {
            display: flex;
        }

        .editor-textarea {
            flex: 1;
            border: none;
            padding: 15px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 14px;
            line-height: 1.5;
            resize: none;
            height: 400px;
            outline: none;
            background: transparent;
            white-space: pre;
            overflow-wrap: normal;
            overflow-x: auto;
        }

        .clips-list {
            margin-top: 30px;
        }

        .clip-item {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 15px;
            border: 2px solid #e9ecef;
            transition: all 0.3s;
            position: relative;
        }

        .clip-item:hover {
            border-color: #667eea;
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .clip-preview {
            font-family: 'Monaco', 'Menlo', monospace;
            color: #555;
            margin-bottom: 10px;
            white-space: pre-wrap;
            word-break: break-word;
            padding-right: 120px;
        }

        .clip-actions {
            position: absolute;
            top: 10px;
            right: 10px;
            display: flex;
            gap: 5px;
        }

        .clip-action-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .clip-action-btn:hover {
            transform: scale(1.1);
        }

        .clip-action-btn.delete {
            background: #dc3545;
        }

        .clip-action-btn.rename {
            background: #28a745;
        }

        .clip-meta {
            color: #6c757d;
            font-size: 12px;
            margin-top: 10px;
            padding-right: 120px;
        }

        .hidden {
            display: none !important;
        }

        .alert {
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
        }

        .alert-success {
            background-color: #d1edff;
            border: 1px solid #bee5eb;
            color: #0c5460;
        }

        .alert-error {
            background-color: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
        }

        .save-controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .pagination {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-top: 20px;
        }

        .pagination button {
            padding: 8px 16px;
            border: 1px solid #dee2e6;
            background: white;
            color: #495057;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .pagination button:hover:not(:disabled) {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }

        .pagination button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .pagination button.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }

        @media (max-width: 768px) {
            .editor-container {
                flex-direction: column;
            }
            
            .container {
                padding: 10px;
            }
            
            .save-controls {
                justify-content: center;
            }

            .clip-preview {
                padding-right: 10px;
            }

            .clip-actions {
                position: relative;
                top: auto;
                right: auto;
                margin-top: 10px;
                justify-content: flex-end;
            }

            .clip-meta {
                padding-right: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📋 在线剪贴板</h1>
        </div>

        <!-- Login Form -->
        <div id="loginForm" class="login-form">
            <h2 style="text-align: center; margin-bottom: 20px; color: #555;">请登录</h2>
            <div class="form-group">
                <label for="password">密码：</label>
                <input type="password" id="password" placeholder="请输入密码">
            </div>
            <button class="btn" onclick="login()" style="width: 100%;">登录</button>
            <div id="loginError" class="alert alert-error hidden">
                <strong>错误：</strong><span id="loginErrorMsg"></span>
            </div>
        </div>

        <!-- Main Content -->
        <div id="mainContent" class="main-content hidden">
            <div id="alerts"></div>
            
            <div class="save-controls">
                <button class="btn" onclick="saveClip()">💾 保存</button>
                <button class="btn" onclick="newClip()">📄 新建</button>
                <button class="btn" onclick="loadClips()">🔄 刷新列表</button>
            </div>

            <div class="editor-container">
                <div class="editor-panel">
                    <div class="editor-header">编辑器</div>
                    <div class="editor-content">
                        <div id="lineNumbers" class="line-numbers">1</div>
                        <textarea id="editor" class="editor-textarea" placeholder="在此输入内容..."></textarea>
                    </div>
                </div>
            </div>

            <div class="clips-list">
                <h3 style="margin-bottom: 20px; color: #555;">📚 已保存的剪贴板</h3>
                <div id="clipsList"></div>
                <div id="pagination" class="pagination"></div>
            </div>
        </div>
    </div>

    <script>
        let currentClipId = null;
        let token = localStorage.getItem('clipboard_token');
        let currentPage = 1;
        let totalPages = 1;

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            if (token) {
                showMainContent();
                initEditor();
                loadClips();
                checkUrlForClip();
            } else {
                showLoginForm();
            }

            // ✅ 修复：在登录页也能按 Enter 提交
            const pwdInput = document.getElementById('password');
            if (pwdInput) {
                pwdInput.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter') {
                        login();
                    }
                });
            }
        });

        function showLoginForm() {
            document.getElementById('loginForm').classList.remove('hidden');
            document.getElementById('mainContent').classList.add('hidden');
        }

        function showMainContent() {
            document.getElementById('loginForm').classList.add('hidden');
            document.getElementById('mainContent').classList.remove('hidden');
        }

        function showAlert(message, type) {
            const alertsContainer = document.getElementById('alerts');
            const alert = document.createElement('div');
            alert.className = 'alert alert-' + (type || 'success');
            alert.innerHTML = '<strong>' + (type === 'error' ? '错误：' : '成功：') + '</strong>' + message;
            alertsContainer.appendChild(alert);
            
            setTimeout(() => {
                alert.remove();
            }, 5000);
        }

        async function login() {
            const password = document.getElementById('password').value;
            const errorDiv = document.getElementById('loginError');
            const errorMsg = document.getElementById('loginErrorMsg');
            
            if (!password) {
                errorMsg.textContent = '请输入密码';
                errorDiv.classList.remove('hidden');
                return;
            }

            try {
                const response = await fetch('/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ password })
                });

                // 即使返回 401，也尝试解析 JSON
                const result = await response.json();
                
                if (response.ok && result.success) {
                    token = result.token;
                    localStorage.setItem('clipboard_token', token);
                    showMainContent();
                    initEditor();
                    loadClips();
                    checkUrlForClip();
                } else {
                    errorMsg.textContent = result.message || '登录失败';
                    errorDiv.classList.remove('hidden');
                }
            } catch (error) {
                errorMsg.textContent = '网络错误，请重试';
                errorDiv.classList.remove('hidden');
            }
        }

        function initEditor() {
            const editor = document.getElementById('editor');
            const lineNumbers = document.getElementById('lineNumbers');

            function updateLineNumbers() {
                const lines = editor.value.split('\\n');
                const lineCount = lines.length;
                let lineNumbersText = '';
                for (let i = 1; i <= lineCount; i++) {
                    lineNumbersText += i + '\\n';
                }
                lineNumbers.textContent = lineNumbersText.slice(0, -1);
            }

            editor.addEventListener('input', updateLineNumbers);
            
            editor.addEventListener('scroll', function() {
                lineNumbers.scrollTop = editor.scrollTop;
            });

            // ❌ 原来这里绑定了密码框回车提交，导致登录页不生效
            // 已移到 DOMContentLoaded 中统一绑定

            updateLineNumbers();
        }

        async function saveClip() {
            const content = document.getElementById('editor').value.trim();
            
            if (!content) {
                showAlert('请输入内容', 'error');
                return;
            }

            try {
                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ 
                        content: content,
                        id: currentClipId
                    })
                });

                const result = await response.json();
                
                if (result.success) {
                    currentClipId = result.id;
                    window.history.pushState({}, '', '/' + result.id);
                    showAlert('剪贴板已保存！链接：' + result.url);
                    loadClips();
                } else {
                    showAlert(result.message || '保存失败', 'error');
                }
            } catch (error) {
                showAlert('网络错误，请重试', 'error');
            }
        }

        function newClip() {
            currentClipId = null;
            document.getElementById('editor').value = '';
            document.getElementById('lineNumbers').textContent = '1';
            window.history.pushState({}, '', '/');
        }

        async function loadClips(page) {
            page = page || 1;
            try {
                const response = await fetch('/api/list?page=' + page, {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                const result = await response.json();
                
                if (result.success) {
                    currentPage = result.currentPage;
                    totalPages = result.totalPages;
                    displayClips(result.clips);
                    displayPagination();
                } else {
                    showAlert(result.message || '加载失败', 'error');
                }
            } catch (error) {
                showAlert('网络错误，请重试', 'error');
            }
        }

        function displayClips(clips) {
            const clipsList = document.getElementById('clipsList');
            
            if (clips.length === 0) {
                clipsList.innerHTML = '<p style="text-align: center; color: #6c757d; padding: 40px;">暂无剪贴板内容</p>';
                return;
            }

            let html = '';
            for (let i = 0; i < clips.length; i++) {
                const clip = clips[i];
                html += '<div class="clip-item">';
                html += '<div class="clip-preview">' + escapeHtml(clip.preview) + '</div>';
                html += '<div class="clip-actions">';
                html += '<button class="clip-action-btn" onclick="copyToClipboard(\\'' + clip.id + '\\')" title="复制内容">';
                html += '<i class="fas fa-copy"></i>';
                html += '</button>';
                html += '<button class="clip-action-btn" onclick="copyLink(\\'' + clip.url + '\\')" title="复制链接">';
                html += '<i class="fas fa-link"></i>';
                html += '</button>';
                html += '<button class="clip-action-btn" onclick="editClip(\\'' + clip.id + '\\')" title="编辑">';
                html += '<i class="fas fa-edit"></i>';
                html += '</button>';
                html += '<button class="clip-action-btn rename" onclick="renameClip(\\'' + clip.id + '\\')" title="重命名">';
                html += '<i class="fas fa-tag"></i>';
                html += '</button>';
                html += '<button class="clip-action-btn delete" onclick="deleteClip(\\'' + clip.id + '\\')" title="删除">';
                html += '<i class="fas fa-trash"></i>';
                html += '</button>';
                html += '</div>';
                html += '<div class="clip-meta">';
                html += 'ID: ' + clip.id + ' | 创建：' + new Date(clip.createdAt).toLocaleString('zh-CN');
                if (clip.updatedAt !== clip.createdAt) {
                    html += ' | 更新：' + new Date(clip.updatedAt).toLocaleString('zh-CN');
                }
                html += '</div>';
                html += '</div>';
            }
            clipsList.innerHTML = html;
        }

        function displayPagination() {
            const paginationDiv = document.getElementById('pagination');
            
            if (totalPages <= 1) {
                paginationDiv.innerHTML = '';
                return;
            }

            let paginationHTML = '';
            
            // Previous button
            paginationHTML += '<button onclick="loadClips(' + (currentPage - 1) + ')" ' + (currentPage === 1 ? 'disabled' : '') + '>上一页</button>';
            
            // Page numbers
            const startPage = Math.max(1, currentPage - 2);
            const endPage = Math.min(totalPages, currentPage + 2);
            
            for (let i = startPage; i <= endPage; i++) {
                paginationHTML += '<button onclick="loadClips(' + i + ')" ' + (i === currentPage ? 'class="active"' : '') + '>' + i + '</button>';
            }
            
            // Next button
            paginationHTML += '<button onclick="loadClips(' + (currentPage + 1) + ')" ' + (currentPage === totalPages ? 'disabled' : '') + '>下一页</button>';
            
            paginationDiv.innerHTML = paginationHTML;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        async function copyToClipboard(clipId) {
            try {
                const response = await fetch('/api/get/' + clipId, {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                const result = await response.json();
                
                if (result.success) {
                    await navigator.clipboard.writeText(result.clip.content);
                    showAlert('内容已复制到剪贴板！');
                } else {
                    showAlert(result.message || '获取内容失败', 'error');
                }
            } catch (error) {
                showAlert('复制失败', 'error');
            }
        }

        async function copyLink(url) {
            try {
                await navigator.clipboard.writeText(url);
                showAlert('链接已复制到剪贴板！');
            } catch (error) {
                showAlert('复制链接失败', 'error');
            }
        }

        async function editClip(clipId) {
            try {
                const response = await fetch('/api/get/' + clipId, {
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                const result = await response.json();
                
                if (result.success) {
                    currentClipId = clipId;
                    document.getElementById('editor').value = result.clip.content;
                    
                    // Update line numbers
                    const lines = result.clip.content.split('\\n');
                    const lineCount = lines.length;
                    let lineNumbersText = '';
                    for (let i = 1; i <= lineCount; i++) {
                        lineNumbersText += i + '\\n';
                    }
                    document.getElementById('lineNumbers').textContent = lineNumbersText.slice(0, -1);
                    
                    window.history.pushState({}, '', '/' + clipId);
                    showAlert('剪贴板已加载到编辑器');
                    
                    // Scroll to editor
                    document.getElementById('editor').scrollIntoView({ behavior: 'smooth' });
                } else {
                    showAlert(result.message || '加载失败', 'error');
                }
            } catch (error) {
                showAlert('网络错误，请重试', 'error');
            }
        }

        async function deleteClip(clipId) {
            if (!confirm('确定要删除这个剪贴板吗？')) {
                return;
            }

            try {
                const response = await fetch('/api/delete/' + clipId, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': 'Bearer ' + token
                    }
                });

                const result = await response.json();
                
                if (result.success) {
                    showAlert('剪贴板已删除');
                    loadClips(currentPage);
                    
                    if (currentClipId === clipId) {
                        newClip();
                    }
                } else {
                    showAlert(result.message || '删除失败', 'error');
                }
            } catch (error) {
                showAlert('网络错误，请重试', 'error');
            }
        }

        async function renameClip(clipId) {
            const newId = prompt('请输入新的链接ID (最少1个字符):', clipId);
            
            if (newId === null || newId === clipId) {
                return; // User cancelled or no change
            }
            
            if (newId.length < 1) {
                showAlert('ID至少需要1个字符', 'error');
                return;
            }

            try {
                const response = await fetch('/api/rename/' + clipId, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ newId: newId })
                });

                const result = await response.json();
                
                if (result.success) {
                    showAlert('重命名成功！新链接：' + result.newUrl);
                    loadClips(currentPage);
                    
                    // Update current clip if it's the one being renamed
                    if (currentClipId === clipId) {
                        currentClipId = newId;
                        window.history.pushState({}, '', '/' + newId);
                    }
                } else {
                    showAlert(result.message || '重命名失败', 'error');
                }
            } catch (error) {
                showAlert('网络错，请重试', 'error');
            }
        }

        async function checkUrlForClip() {
            const path = window.location.pathname;
            const clipId = path.substring(1);
            
            if (clipId && clipId !== '') {
                await editClip(clipId);
            }
        }
    </script>
</body>
</html>`;
