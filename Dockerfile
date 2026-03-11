FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip curl unzip && pip3 install yt-dlp --break-system-packages && rm -rf /var/lib/apt/lists/*
# Install deno for yt-dlp JS challenge solving
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"
# Pre-download yt-dlp EJS components
RUN yt-dlp --remote-components ejs:github --update-to stable 2>/dev/null || true
WORKDIR /app
COPY package*.json ./
RUN npm install --prefer-offline || npm install --registry https://registry.npmmirror.com
COPY . .
RUN mkdir -p temp
EXPOSE 3000
CMD ["node", "server.js"]
