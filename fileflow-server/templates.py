def upload_page_html(file_id: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FileFlow — Send to Firefox</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #f8f6ff 0%, #fff4f0 100%);
            padding: 24px;
        }}
        .container {{
            text-align: center;
            max-width: 380px;
            width: 100%;
        }}
        .logo {{
            width: 100px;
            height: auto;
            margin-bottom: 20px;
            filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.1));
        }}
        .success-img {{
            width: 180px;
            height: auto;
            margin-bottom: 24px;
            filter: drop-shadow(0 4px 16px rgba(0, 0, 0, 0.08));
            animation: float 3s ease-in-out infinite;
        }}
        @keyframes float {{
            0%, 100% {{ transform: translateY(0); }}
            50% {{ transform: translateY(-8px); }}
        }}
        h1 {{
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 8px;
            color: #1a1a2e;
            letter-spacing: -0.02em;
        }}
        .subtitle {{
            font-size: 0.95rem;
            color: #6b7280;
            margin-bottom: 32px;
            font-weight: 400;
        }}
        .btn {{
            display: inline-flex;
            justify-content: center;
            align-items: center;
            padding: 18px 48px;
            font-family: 'Inter', sans-serif;
            font-size: 1.1rem;
            font-weight: 600;
            background: linear-gradient(135deg, #ff6b35 0%, #ff3864 50%, #9b59b6 100%);
            color: white;
            border: none;
            border-radius: 16px;
            cursor: pointer;
            min-height: 56px;
            width: 100%;
            box-shadow: 0 4px 16px rgba(255, 56, 100, 0.3);
            transition: transform 0.15s ease, box-shadow 0.15s ease;
            text-decoration: none;
        }}
        .btn:active {{
            transform: scale(0.97);
            box-shadow: 0 2px 8px rgba(255, 56, 100, 0.3);
        }}
        .status {{
            margin-top: 24px;
            font-size: 1rem;
            color: #6b7280;
            font-weight: 500;
        }}
        .success-container {{
            animation: fadeIn 0.5s ease;
        }}
        .success-text {{
            font-size: 1.3rem;
            font-weight: 700;
            color: #1a1a2e;
            margin-bottom: 8px;
            letter-spacing: -0.02em;
        }}
        .success-sub {{
            font-size: 0.95rem;
            color: #6b7280;
            font-weight: 400;
        }}
        .error-text {{
            color: #dc2626;
            font-weight: 500;
        }}
        .progress-wrapper {{
            margin-top: 24px;
            width: 100%;
        }}
        .progress-bar {{
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #e5e7eb;
            overflow: hidden;
        }}
        .progress-fill {{
            height: 100%;
            border-radius: 3px;
            background: linear-gradient(90deg, #ff6b35, #ff3864, #9b59b6);
            width: 0%;
            transition: width 0.2s ease;
        }}
        .progress-label {{
            margin-top: 12px;
            font-size: 0.9rem;
            color: #9ca3af;
            font-weight: 500;
        }}
        .hidden {{ display: none; }}
        @keyframes fadeIn {{
            from {{ opacity: 0; transform: translateY(12px); }}
            to {{ opacity: 1; transform: translateY(0); }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div id="uploadView">
            <img src="/images/kit-tail-folder-bookmarks.png" alt="FileFlow" class="logo">
            <h1>Send to Firefox</h1>
            <p class="subtitle">Select an image to transfer</p>
            <label class="btn" for="fileInput">
                Choose Image
            </label>
            <input type="file" id="fileInput" accept="image/*" class="hidden">
            <div id="progressWrapper" class="progress-wrapper hidden">
                <div class="progress-bar">
                    <div id="progressFill" class="progress-fill"></div>
                </div>
                <div id="progressLabel" class="progress-label">Uploading...</div>
            </div>
            <div id="status" class="status"></div>
        </div>
        <div id="successView" class="success-container hidden">
            <img src="/images/kit-jump-hole-1.png" alt="Success!" class="success-img">
            <p class="success-text">Your files are on the way!!</p>
            <p class="success-sub">You can close this page now</p>
        </div>
    </div>
    <script>
        const fileInput = document.getElementById("fileInput");
        const selectLabel = document.querySelector("label.btn");
        const progressWrapper = document.getElementById("progressWrapper");
        const progressFill = document.getElementById("progressFill");
        const progressLabel = document.getElementById("progressLabel");
        const statusEl = document.getElementById("status");
        const uploadView = document.getElementById("uploadView");
        const successView = document.getElementById("successView");
        const uploadUrl = "/upload/{file_id}";

        fileInput.addEventListener("change", function() {{
            if (!fileInput.files.length) return;
            upload(fileInput.files[0]);
        }});

        function upload(file) {{
            selectLabel.classList.add("hidden");
            progressWrapper.classList.remove("hidden");
            statusEl.textContent = "";

            const xhr = new XMLHttpRequest();
            xhr.open("POST", uploadUrl);

            xhr.upload.onprogress = function(e) {{
                if (e.lengthComputable) {{
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressFill.style.width = pct + "%";
                    progressLabel.textContent = pct < 100 ? "Uploading... " + pct + "%" : "Processing...";
                }}
            }};

            xhr.onload = function() {{
                if (xhr.status === 200) {{
                    uploadView.classList.add("hidden");
                    successView.classList.remove("hidden");
                }} else {{
                    showError();
                }}
            }};

            xhr.onerror = function() {{
                showError();
            }};

            const formData = new FormData();
            formData.append("file", file);
            xhr.send(formData);
        }}

        function showError() {{
            progressWrapper.classList.add("hidden");
            selectLabel.classList.remove("hidden");
            statusEl.innerHTML = '<span class="error-text">Upload failed. Tap to try again.</span>';
        }}
    </script>
</body>
</html>"""
