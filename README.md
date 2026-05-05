# Promise · 双人学习打卡

仅限两位用户：`Qsky` 与 `我爱刘涛`。屏幕左右两栏，最下方为合并的全局打卡时间线。

## 功能

- **两人专属登录**：用户名仅接受 `Qsky` / `我爱刘涛`，首次进入设置密码。
- **左右分屏**：左 Qsky · 右 我爱刘涛，各自管理自己的内容，对方只读。
- **底部全局时间线**：CF 风格，可点开任意打卡看完整内容（含图片、Markdown）。
- **模块**：单词 / 卷子（含答题 + 自动汇入错题）/ 错题本 / 数学 / 便利贴 / 每日总结。
- **便利贴**：支持 Markdown，含 GFM 任务列表 `- [ ]` 可点击勾选；含图片；过 0 点自动归档到"历史便利贴"。
- **每日总结**：每人每天一条，Markdown + 图片。
- **进度条**：英语专项的「卷子目标」和「单词掌握目标」，每人各自设定。
- **图片**：所有内容都能粘贴（Ctrl+V）/ 拖拽 / 点击上传。
- **实时同步**：两人同时在线，打卡通过 SSE 即时推送。

## 本地启动

```powershell
node server.js
```

访问 `http://localhost:3000`。

## 服务器部署（Ubuntu / Debian）

适用：阿里云 ECS、Ubuntu 24.04 全新空机。

```bash
# 1) 上传代码到服务器（任选其一）
git clone https://github.com/<你的用户名>/<仓库名>.git /opt/promise
# 或 scp -r english-study-checkin/ root@<IP>:/opt/promise

# 2) 一键部署（装 Node 20、systemd 服务、可选 nginx）
cd /opt/promise
sudo bash scripts/deploy-ubuntu.sh
```

部署后：

```bash
sudo systemctl status promise       # 查看运行状态
sudo journalctl -u promise -f       # 实时日志
sudo systemctl restart promise      # 重启
```

**别忘了**：阿里云控制台「安全组」要放行 `3000`（或 `80`/`443` 如开了 nginx）的入方向。

## 上传到 GitHub

仓库已经初始化好 `.gitignore`，**不会**把 `data/`、`old_data/`、`.env`、`bin/` 上传。

```powershell
# 在项目根目录
git add -A
git commit -m "Initial: 双人学习打卡"

# 在 GitHub 上新建空仓库（不要勾 README/gitignore）
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

之后在服务器：

```bash
cd /opt/promise
git pull
sudo systemctl restart promise
```

## 数据存储

- `data/store.json` — 全部数据（用户、密码、打卡、卷子、单词、错题、便利贴、总结、目标）
- `data/uploads/` — 上传的图片
- `old_data/store.<时间戳>.json` — 旧版本备份
- `old_data/legacy/` — 旧前端文件备份

> 密码以明文存储在 `data/store.json`，因为你说"反正都在我服务器上"。请保护好该文件的访问权限。

## 卷子 JSON 格式（导入用）

```json
{
  "id": "cet6_demo",
  "title": "CET6 Demo",
  "tags": ["CET6"],
  "sections": [
    {
      "title": "Reading",
      "questions": [
        {
          "id": "1",
          "type": "choice",
          "prompt": "The word meticulous is closest in meaning to ____.",
          "options": ["careless", "precise", "rapid", "ordinary"],
          "answer": "precise",
          "note": "meticulous 表示非常仔细的"
        }
      ]
    }
  ]
}
```

提交答题后：错题自动汇入「错题本」，并产生一条时间线打卡。

## 目录结构

```
english-study-checkin/
├── server.js              # Node HTTP 服务（无外部依赖）
├── public/                # 前端（Vue 3 CDN）
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── icon.svg
├── scripts/
│   └── deploy-ubuntu.sh   # 一键部署脚本
├── data/                  # 运行时数据（git 忽略）
│   ├── store.json
│   └── uploads/
├── old_data/              # 旧数据 / 旧前端备份（git 忽略）
└── .env.example
```
