let mytoken = 'passwd';

export default {
    async fetch(request, env) {
        try {
            mytoken = env.TOKEN || mytoken;

            if (!env.KV) {
                throw new Error('KV 命名空间未绑定');
            }

            const url = new URL(request.url);
            const token = url.pathname === `/${mytoken}` ? mytoken : (url.searchParams.get('token') || "null");

            if (token !== mytoken) {
                return createResponse('token 有误', 403);
            }

            let fileName = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
            //fileName = fileName.toLowerCase(); // 将文件名转换为小写

            // 处理API请求
            if (fileName === 'api/list') {
                return await handleListKeys(env.KV);
            }

            if (fileName === 'api/save' && request.method === 'POST') {
                return await handleSaveKey(env.KV, request);
            }

            if (fileName === 'api/delete' && request.method === 'POST') {
                return await handleDeleteKey(env.KV, request);
            }

            switch (fileName) {
                case "config":
                case mytoken:
                    return createResponse(configHTML(url.hostname, token), 200, { 'Content-Type': 'text/html; charset=UTF-8' });
                case "config/update.bat":
                    return createResponse(generateBatScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.bat', "Content-Type": "text/plain; charset=utf-8" });
                case "config/update.sh":
                    return createResponse(generateShScript(url.hostname, token), 200, { "Content-Disposition": 'attachment; filename=update.sh', "Content-Type": "text/plain; charset=utf-8" });
                default:
                    return await handleFileOperation(env.KV, fileName, url, token);
            }
        } catch (error) {
            console.error("Error:", error);
            return createResponse(`Error: ${error.message}`, 500);
        }
    }
};

/**
 * 处理获取所有键值对的请求
 */
async function handleListKeys(KV) {
    try {
        const keys = await KV.list();
        const keyValuePairs = [];
        
        for (const key of keys.keys) {
            const value = await KV.get(key.name);
            keyValuePairs.push({
                key: key.name,
                value: value || '',
                size: new Blob([value || '']).size
            });
        }
        
        return createResponse(JSON.stringify(keyValuePairs), 200, { 'Content-Type': 'application/json' });
    } catch (error) {
        return createResponse(JSON.stringify({ error: error.message }), 500, { 'Content-Type': 'application/json' });
    }
}

/**
 * 处理保存键值对的请求
 */
async function handleSaveKey(KV, request) {
    try {
        const { key, value } = await request.json();
        
        if (!key) {
            throw new Error('Key is required');
        }
        
        await KV.put(key, value || '');
        return createResponse(JSON.stringify({ success: true, message: '保存成功' }), 200, { 'Content-Type': 'application/json' });
    } catch (error) {
        return createResponse(JSON.stringify({ error: error.message }), 500, { 'Content-Type': 'application/json' });
    }
}

/**
 * 处理删除键值对的请求
 */
async function handleDeleteKey(KV, request) {
    try {
        const { key } = await request.json();
        
        if (!key) {
            throw new Error('Key is required');
        }
        
        await KV.delete(key);
        return createResponse(JSON.stringify({ success: true, message: '删除成功' }), 200, { 'Content-Type': 'application/json' });
    } catch (error) {
        return createResponse(JSON.stringify({ error: error.message }), 500, { 'Content-Type': 'application/json' });
    }
}

/**
 * 处理文件操作
 * @param {Object} KV - KV 命名空间实例
 * @param {String} fileName - 文件名
 * @param {Object} url - URL 实例
 * @param {String} token - 认证 token
 */
async function handleFileOperation(KV, fileName, url, token) {
    const text = url.searchParams.get('text') || null;
    const b64 = url.searchParams.get('b64') || null;

    // 如果没有传递 text 或 b64 参数，尝试从 KV 存储中获取文件内容
    if (!text && !b64) {
        const value = await KV.get(fileName, { cacheTtl: 60 });
        if (value === null) {
            return createResponse('File not found', 404);
        }
        return createResponse(value);
    }

    // 如果传递了 text 或 b64 参数，将内容写入 KV 存储
    let content = text || base64Decode(replaceSpacesWithPlus(b64));
    await KV.put(fileName, content);
    const verifiedContent = await KV.get(fileName, { cacheTtl: 60 });

    if (verifiedContent !== content) {
        throw new Error('Content verification failed after write operation');
    }

    return createResponse(verifiedContent);
}

/**
 * 创建 HTTP 响应
 * @param {String} body - 响应内容
 * @param {Number} status - HTTP 状态码
 * @param {Object} additionalHeaders - 额外的响应头部信息
 */
function createResponse(body, status = 200, additionalHeaders = {}) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'ETag': Math.random().toString(36).substring(2, 15),
        'Last-Modified': new Date().toUTCString(),
        'cf-cache-status': 'DYNAMIC',
        ...additionalHeaders
    };
    return new Response(body, { status, headers });
}

/**
 * 解码 base64 字符串
 * @param {String} str - base64 字符串
 */
function base64Decode(str) {
    try {
        const bytes = new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
        return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
        throw new Error('Invalid base64 string');
    }
}

/**
 * 将字符串中的空格替换为加号
 * @param {String} str - 输入字符串
 */
function replaceSpacesWithPlus(str) {
    return str.replace(/ /g, '+');
}

/**
 * 生成 Windows bat 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateBatScript(domain, token) {
    return [
        '@echo off',
        'chcp 65001',
        'setlocal',
        '',
        `set "DOMAIN=${domain}"`,
        `set "TOKEN=${token}"`,
        '',
        'set "FILENAME=%~nx1"',
        '',
        'for /f "delims=" %%i in (\'powershell -command "$content = ((Get-Content -Path \'%cd%/%FILENAME%\' -Encoding UTF8) | Select-Object -First 65) -join [Environment]::NewLine; [convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($content))"\') do set "BASE64_TEXT=%%i"',
        '',
        'set "URL=https://%DOMAIN%/%FILENAME%?token=%TOKEN%^&b64=%BASE64_TEXT%"',
        '',
        'start %URL%',
        'endlocal',
        '',
        'echo 更新数据完成,倒数5秒后自动关闭窗口...',
        'timeout /t 5 >nul',
        'exit'
    ].join('\r\n');
}

/**
 * 生成 Linux sh 脚本
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function generateShScript(domain, token) {
    return `#!/bin/bash
export LANG=zh_CN.UTF-8
DOMAIN="${domain}"
TOKEN="${token}"
if [ -n "$1" ]; then 
  FILENAME="$1"
else
  echo "无文件名"
  exit 1
fi
BASE64_TEXT=$(head -n 65 $FILENAME | base64 -w 0)
curl -k "https://\${DOMAIN}/\${FILENAME}?token=\${TOKEN}&b64=\${BASE64_TEXT}"
echo "更新数据完成"
`;
}

/**
 * 生成 HTML 配置页面
 * @param {String} domain - 域名
 * @param {String} token - 认证 token
 */
function configHTML(domain, token) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CF-Workers-TEXT2KV 配置信息</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 15px; max-width: 1200px; margin: 0 auto; }
        h1 { text-align: center; }
        h2 { text-align: left; font-size:1.3rem}
        pre,code { padding: 0px; border-radius: 8px; overflow-x: auto; white-space: nowrap; }
        pre code { background: none; padding: 0; border: none; }
        button { 
            white-space: nowrap;
            cursor: pointer; 
            padding: 10px 10px; 
            margin-top: 0px; 
            border: none; 
            border-radius: 5px; 
            flex-shrink: 0;
        }
        button:hover { opacity: 0.9; }
        input[type="text"], textarea { 
            padding: 9px 10px;
            border-radius: 5px;
            flex-grow: 1;
            min-width:0;
        }
        textarea {
            min-height: 100px;
            resize: vertical;
            font-family: monospace;
        }
        .tips {
            color:grey;
            font-size:0.8em;
            border-left: 1px solid #666;
            padding-left: 10px;
        }
        .container { 
            padding: 5px 15px 15px 15px; 
            border-radius: 10px; 
            box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
            margin-bottom: 20px;
        }
        .flex-row { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-top:-10px !important;
            margin-bottom:-10px !important;
        }
        .download-button {
            padding: 5px 10px;
            margin:0 !important;
            background-color: Indigo !important;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            transition: background-color 0.3s;
        }
        .download-button:hover {
            background-color: #45a049;
        }
        .input-button-container {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        /* KV列表相关样式 */
        .kv-list {
            margin-top: 20px;
        }
        .kv-item {
            border: 1px solid #ddd;
            border-radius: 8px;
            margin-bottom: 10px;
            padding: 15px;
            position: relative;
        }
        .kv-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .kv-key {
            font-weight: bold;
            font-size: 1.1em;
        }
        .kv-actions {
            display: flex;
            gap: 5px;
        }
        .kv-actions button {
            padding: 5px 10px;
            font-size: 0.9em;
        }
        .copy-btn {
            background-color: #17a2b8;
            color: white;
        }
        .view-btn {
            background-color: #28a745;
            color: white;
        }
        .edit-btn {
            background-color: #007bff;
            color: white;
        }
        .save-btn {
            background-color: #28a745;
            color: white;
        }
        .cancel-btn {
            background-color: #6c757d;
            color: white;
        }
        .delete-btn {
            background-color: #dc3545;
            color: white;
        }
        .kv-value-display {
            background-color: #f8f9fa;
            padding: 10px;
            border-radius: 5px;
            white-space: pre-wrap;
            font-family: monospace;
            max-height: 200px;
            overflow-y: auto;
        }
        .kv-value-edit {
            width: 100%;
            min-height: 150px;
            font-family: monospace;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 5px;
        }
        .kv-info {
            font-size: 0.9em;
            color: #666;
            margin-top: 5px;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #666;
        }
        .add-new {
            margin-bottom: 20px;
        }
        .add-new-form {
            display: none;
            border: 2px dashed #ddd;
            border-radius: 8px;
            padding: 15px;
            margin-top: 10px;
        }
        .add-new-form.show {
            display: block;
        }

        /* Light theme */
        body.light { background-color: #f0f0f0; color: #333; }
        h1.light { color: #444; }
        pre.light { background-color: #fff; border: 1px solid #ddd; }
        button.light { background-color: DarkViolet; color: #fff; }
        input[type="text"].light, textarea.light { border: 1px solid #ddd; }
        .container.light { background-color: #fff; }
        .kv-item.light { border-color: #ddd; background-color: #fff; }
        .kv-value-display.light { background-color: #f8f9fa; }

        /* Dark theme */
        body.dark { background-color: #1e1e1e; color: #c9d1d9; }
        h1.dark { color: #c9d1d9; }
        pre.dark { background-color: #2d2d2d; border: 1px solid #444; }
        button.dark { background-color: DarkViolet; color: #c9d1d9; }
        input[type="text"].dark, textarea.dark { border: 1px solid #444; background-color: #2d2d2d; color: #c9d1d9; }
        .container.dark { background-color: #2d2d2d; }
        .kv-item.dark { border-color: #444; background-color: #2d2d2d; }
        .kv-value-display.dark { background-color: #1e1e1e; color: #c9d1d9; }
        .kv-value-edit.dark { background-color: #1e1e1e; color: #c9d1d9; }
    </style>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/obsidian.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js"></script>
    <script>hljs.highlightAll();</script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            document.body.classList.add(theme);
            document.querySelectorAll('h1, pre, button, input[type="text"], textarea, .container, .kv-item, .kv-value-display, .kv-value-edit').forEach(el => el.classList.add(theme));
            
            // 加载KV列表
            loadKVList();
        });
    </script>
</head>
<body>
    <h1>TEXT2KV 配置信息</h1>
    
    <div class="container">
        <p>
            <strong>服务域名:</strong> ${domain}<br>
            <strong>TOKEN:</strong> ${token}<br>
        </p>
        
        <h2>在线文档查询:</h2>
        <div class="input-button-container">
            <input type="text" id="keyword" placeholder="请输入要查询的文档">
            <button onclick="viewDocument()">查看文档内容</button>
            <button onclick="copyDocumentURL()">复制文档地址</button>
        </div>
    </div>

    <div class="container">
        <div class="flex-row">
            <h2>KV存储列表</h2>
            <button class="download-button" onclick="loadKVList()">刷新列表</button>
        </div>
        
        <div class="add-new">
            <button onclick="toggleAddNew()" class="download-button">添加新文档</button>
            <div class="add-new-form" id="addNewForm">
                <div style="margin-bottom: 10px;">
                    <input type="text" id="newKey" placeholder="文档名称/键" style="width: 100%;">
                </div>
                <div style="margin-bottom: 10px;">
                    <textarea id="newValue" placeholder="文档内容/值" style="width: 100%; min-height: 100px;"></textarea>
                </div>
                <div>
                    <button onclick="saveNewKV()" class="save-btn">保存</button>
                    <button onclick="toggleAddNew()" class="cancel-btn">取消</button>
                </div>
            </div>
        </div>
        
        <div id="kvList" class="kv-list">
            <div class="loading">正在加载...</div>
        </div>
    </div>

    <script>
        const domain = '${domain}';
        const token = '${token}';
        
        /**
         * 加载KV列表
         */
        async function loadKVList() {
            const kvList = document.getElementById('kvList');
            kvList.innerHTML = '<div class="loading">正在加载...</div>';
            
            try {
                const response = await fetch(\`https://\${domain}/api/list?token=\${token}&t=\${Date.now()}\`);
                const data = await response.json();
                
                if (response.ok) {
                    renderKVList(data);
                } else {
                    kvList.innerHTML = \`<div class="loading">加载失败: \${data.error || '未知错误'}</div>\`;
                }
            } catch (error) {
                kvList.innerHTML = \`<div class="loading">加载失败: \${error.message}</div>\`;
            }
        }
        
        /**
         * 渲染KV列表
         */
        function renderKVList(data) {
            const kvList = document.getElementById('kvList');
            
            if (data.length === 0) {
                kvList.innerHTML = '<div class="loading">暂无数据</div>';
                return;
            }
            
            const html = data.map(item => \`
                <div class="kv-item" id="item-\${btoa(item.key)}">
                    <div class="kv-header">
                        <div class="kv-key">\${escapeHtml(item.key)}</div>
                        <div class="kv-actions">
                            <button class="copy-btn" onclick="copyDocumentURLByKey('\${escapeHtml(item.key)}')">复制地址</button>
                            <button class="view-btn" onclick="viewDocumentByKey('\${escapeHtml(item.key)}')">查看文档</button>
                            <button class="edit-btn" onclick="editKV('\${btoa(item.key)}')">编辑</button>
                            <button class="delete-btn" onclick="deleteKV('\${btoa(item.key)}', '\${escapeHtml(item.key)}')">删除</button>
                        </div>
                    </div>
                    <div class="kv-value-display" id="display-\${btoa(item.key)}">\${escapeHtml(item.value)}</div>
                    <div class="kv-info">大小: \${item.size} 字节</div>
                    <div style="display: none;" id="edit-\${btoa(item.key)}">
                        <textarea class="kv-value-edit" id="textarea-\${btoa(item.key)}">\${escapeHtml(item.value)}</textarea>
                        <div style="margin-top: 10px;">
                            <button class="save-btn" onclick="saveKV('\${btoa(item.key)}', '\${escapeHtml(item.key)}')">保存</button>
                            <button class="cancel-btn" onclick="cancelEdit('\${btoa(item.key)}')">取消</button>
                        </div>
                    </div>
                </div>
            \`).join('');
            
            kvList.innerHTML = html;
            
            // 应用主题
            const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
            document.querySelectorAll('.kv-item, .kv-value-display, .kv-value-edit').forEach(el => el.classList.add(theme));
        }
        
        /**
         * 根据键名查看文档内容
         */
        function viewDocumentByKey(key) {
            const url = \`https://\${domain}/\${key}?token=\${token}&t=\${Date.now()}\`;
            window.open(url, '_blank');
        }
        
        /**
         * 根据键名复制文档地址
         */
        function copyDocumentURLByKey(key) {
            const url = \`https://\${domain}/\${key}?token=\${token}&t=\${Date.now()}\`;
            navigator.clipboard.writeText(url).then(() => {
                // 复制成功，不显示提示
            }).catch(err => {
                console.error('复制失败:', err);
            });
        }
        
        /**
         * 编辑KV
         */
        function editKV(encodedKey) {
            const displayEl = document.getElementById(\`display-\${encodedKey}\`);
            const editEl = document.getElementById(\`edit-\${encodedKey}\`);
            
            displayEl.style.display = 'none';
            editEl.style.display = 'block';
        }
        
        /**
         * 取消编辑
         */
        function cancelEdit(encodedKey) {
            const displayEl = document.getElementById(\`display-\${encodedKey}\`);
            const editEl = document.getElementById(\`edit-\${encodedKey}\`);
            
            displayEl.style.display = 'block';
            editEl.style.display = 'none';
        }
        
        /**
         * 保存KV
         */
        async function saveKV(encodedKey, key) {
            const textarea = document.getElementById(\`textarea-\${encodedKey}\`);
            const value = textarea.value;
            
            try {
                const response = await fetch(\`https://\${domain}/api/save?token=\${token}\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ key: key, value: value })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    loadKVList(); // 重新加载列表
                } else {
                    alert(\`保存失败: \${result.error || '未知错误'}\`);
                }
            } catch (error) {
                alert(\`保存失败: \${error.message}\`);
            }
        }
        
        /**
         * 删除KV
         */
        async function deleteKV(encodedKey, key) {
            if (!confirm(\`确定要删除文档 "\${key}" 吗？此操作不可恢复。\`)) {
                return;
            }
            
            try {
                const response = await fetch(\`https://\${domain}/api/delete?token=\${token}\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ key: key })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    alert('删除成功');
                    loadKVList(); // 重新加载列表
                } else {
                    alert(\`删除失败: \${result.error || '未知错误'}\`);
                }
            } catch (error) {
                alert(\`删除失败: \${error.message}\`);
            }
        }
        
        /**
         * 切换添加新文档表单
         */
        function toggleAddNew() {
            const form = document.getElementById('addNewForm');
            form.classList.toggle('show');
            
            if (!form.classList.contains('show')) {
                document.getElementById('newKey').value = '';
                document.getElementById('newValue').value = '';
            }
        }
        
        /**
         * 保存新KV
         */
        async function saveNewKV() {
            const key = document.getElementById('newKey').value.trim();
            const value = document.getElementById('newValue').value;
            
            if (!key) {
                alert('请输入文档名称');
                return;
            }
            
            try {
                const response = await fetch(\`https://\${domain}/api/save?token=\${token}\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ key: key, value: value })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    toggleAddNew();
                    loadKVList(); // 重新加载列表
                } else {
                    alert(\`保存失败: \${result.error || '未知错误'}\`);
                }
            } catch (error) {
                alert(\`保存失败: \${error.message}\`);
            }
        }
        
        /**
         * HTML转义
         */
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        /**
         * 查看文档内容
         */
        function viewDocument() {
            const keyword = document.getElementById('keyword').value;
            window.open('https://${domain}/' + keyword + '?token=${token}&t=' + Date.now(), '_blank');
        }

        /**
         * 复制文档地址到剪贴板
         */
        function copyDocumentURL() {
            const keyword = document.getElementById('keyword').value;
            const url = 'https://${domain}/' + keyword + '?token=${token}&t=' + Date.now();
            navigator.clipboard.writeText(url);
        }
    </script>
</body>
</html>
    `;
}