FROM --platform=linux/amd64 kalilinux/kali-rolling AS base

ARG KALI_MIRROR=http://mirrors.ustc.edu.cn/kali
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG all_proxy
ARG no_proxy

ENV DEBIAN_FRONTEND=noninteractive
ENV AGENT_BROWSER_HEADLESS=1
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# COPY ./binary/tch-headless/tch-headless-linux-amd64 .

# RUN mv tch-headless-linux-amd64 /usr/local/bin/tch-headless

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    printf 'deb %s kali-rolling main contrib non-free non-free-firmware\n' "$KALI_MIRROR" > /etc/apt/sources.list; \
    printf 'deb-src %s kali-rolling main contrib non-free non-free-firmware\n' "$KALI_MIRROR" >> /etc/apt/sources.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        7zip \
        7zip-rar \
        unzip \
        jq \
        file \
        xxd \
        binutils \
        openssh-client \
        openssh-server \
        iproute2 \
        iputils-ping \
        xdg-utils \
        \
        default-jre-headless \
        default-mysql-client \
        python3 \
        python-is-python3 \
        python3-pip \
        python3-venv \
        sqlite3 \
        pipx \
        \
        chromium \
        chromium-sandbox \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-cjk \
        \
        fcrackzip \
        hashcat \
        hydra \
        john \
        nmap \
        gobuster \
        whatweb \
        rarcrack \
        sslscan \
        sqlmap \
        proxychains4 \
        seclists \
        wordlists \
        wfuzz \
        dirsearch \
        redis-tools \
        responder \
        enum4linux \
        \
        golang-go \
        nikto \
        wpscan \
        joomscan \
        feroxbuster \
        wafw00f \
        commix \
        masscan \
        amass \
        mitmproxy \
        sslyze \
        testssl.sh \
        binwalk \
        jadx \
        apktool \
        exploitdb \
        arjun \
        dirb \
        sublist3r \
        theharvester \
        crackmapexec \
        subfinder \
        naabu \
        dnsx \
        httpx-toolkit \
        chisel \
        bind9-dnsutils \
        dnsrecon; \
    rm -rf /var/lib/apt/lists/*

RUN python -m pip install --break-system-packages --ignore-installed --no-cache-dir \
        "cryptography>=36.0.1" \
        httpx \
        "idna>=3.3" \
        "pyOpenSSL>=22.0.0" \
        "requests>=2.27.0" \
        websocket-client \
        dnspython \
        pwntools \
        pycryptodome \
        pypsrp \
        scapy \
        beautifulsoup4 \
        "lxml>=4.9.2" \
        pyyaml \
        jsbeautifier \
        python-socketio \
        colorama \
        tqdm \
        rich \
        flask \
        jinja2 \
        flask-unsign \
        pyjwt \
        sympy \
        z3-solver \
        impacket \
        certipy-ad \
        bloodhound \
        ldapdomaindump \
        requests_ntlm2 \
        tldextract \
        urllib3 \
        coercer \
        dsinternals \
        asyncssh \
        "mcp[cli]"

ENV PATH="/root/.local/bin:$PATH"
RUN pipx install pypykatz \
    && pipx install coercer \
    && pipx install "git+https://github.com/Pennyw0rth/NetExec" \
    && pipx install adidnsdump \
    && pipx install bloodyAD \
    && pipx install semgrep \
    && pipx install objection \
    && pipx install frida-tools \
    && pipx install dnstwist

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Go 工具：apt 没有的 ProjectDiscovery / Go 系工具，统一装到 /usr/local/bin（在 PATH）。
ENV GOBIN=/usr/local/bin
ENV GOPATH=/root/go
ENV GOPROXY=https://goproxy.cn,direct
RUN set -eux; \
    for pkg in \
        github.com/projectdiscovery/katana/cmd/katana@latest \
        github.com/projectdiscovery/asnmap/cmd/asnmap@latest \
        github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest \
        github.com/hahwul/dalfox/v2@latest \
        github.com/lc/gau/v2/cmd/gau@latest \
        github.com/tomnomnom/waybackurls@latest \
        github.com/tomnomnom/qsreplace@latest \
        github.com/tomnomnom/assetfinder@latest \
        github.com/PentestPad/subzy@latest \
        github.com/dwisiswant0/crlfuzz/cmd/crlfuzz@latest \
        ; do \
        go install "$pkg" || echo "WARN: go install failed for $pkg"; \
    done; \
    rm -rf /root/go/pkg /root/.cache/go-build


RUN apt-get update \
    && (apt-get install -y --no-install-recommends ncat || apt-get install -y --no-install-recommends netcat-openbsd || echo "No netcat variant available") \
    && rm -rf /var/lib/apt/lists/*

FROM base AS agent-browser-builder

ARG AGENT_BROWSER_VERSION=latest

RUN npm install -g --prefix /opt/agent-browser "agent-browser@${AGENT_BROWSER_VERSION}" \
    && /opt/agent-browser/bin/agent-browser --version

RUN wget "https://github.com/ffuf/ffuf/releases/download/v2.1.0/ffuf_2.1.0_linux_amd64.tar.gz" \
    && tar -zxvf ffuf_2.1.0_linux_amd64.tar.gz \
    && cp ffuf /opt/ffuf

RUN wget "https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64" \
    && cp kerbrute_linux_amd64 /opt/kerbrute

RUN wget "https://github.com/shadow1ng/fscan/releases/download/1.8.4/fscan" \
    && cp fscan /opt/fscan

RUN wget "https://github.com/projectdiscovery/nuclei/releases/download/v3.7.1/nuclei_3.7.1_linux_amd64.zip" \
    && unzip nuclei_3.7.1_linux_amd64.zip -d /tmp/nuclei \
    && cp /tmp/nuclei/nuclei /opt/nuclei \
    && rm -rf nuclei_3.7.1_linux_amd64.zip /tmp/nuclei

FROM base

COPY --from=agent-browser-builder /opt/agent-browser /opt/agent-browser
COPY --from=agent-browser-builder /opt/ffuf /opt/ffuf
COPY --from=agent-browser-builder /opt/kerbrute /opt/kerbrute
COPY --from=agent-browser-builder /opt/fscan /opt/fscan
COPY --from=agent-browser-builder /opt/nuclei /opt/nuclei

RUN ln -sf /opt/agent-browser/bin/agent-browser /usr/local/bin/agent-browser \
    && agent-browser --version \
    && agent-browser open about:blank \
    && agent-browser get title \
    && agent-browser close
RUN chmod +x /opt/ffuf && ln -sf /opt/ffuf /usr/local/bin/ffuf
RUN chmod +x /opt/kerbrute && ln -sf /opt/kerbrute /usr/local/bin/kerbrute
RUN chmod +x /opt/fscan && ln -sf /opt/fscan /usr/local/bin/fscan
RUN chmod +x /opt/nuclei && ln -sf /opt/nuclei /usr/local/bin/nuclei

# nuclei-templates
RUN git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git /root/nuclei-templates

# AD 攻击工具
RUN git clone --depth 1 https://github.com/Ridter/noPac.git /opt/noPac
RUN git clone --depth 1 https://github.com/dirkjanm/CVE-2020-1472.git /opt/zerologon
RUN git clone --depth 1 https://github.com/ly4k/PetitPotam.git /opt/petitpotam
RUN git clone --depth 1 https://github.com/topotam/PetitPotam.git /opt/PetitPotam
RUN git clone --depth 1 https://github.com/dirkjanm/krbrelayx.git /opt/krbrelayx
RUN git clone --depth 1 https://github.com/dirkjanm/PKINITtools.git /opt/PKINITtools
RUN git clone --depth 1 https://github.com/GhostPack/Rubeus.git /opt/Rubeus

# GitHub release 二进制（apt/go/pipx 都没有的），统一落到 /usr/local/bin。
RUN set -eux; \
    install_tar() { \
        url="$1"; bin="$2"; out="$3"; \
        wget -q -O "/tmp/t.tgz" "$url" && tar -xzf /tmp/t.tgz -C /tmp "$bin" \
            && mv "/tmp/$bin" "/usr/local/bin/$out" && chmod +x "/usr/local/bin/$out" \
            && echo "installed $out" || echo "WARN: tar install failed for $out ($url)"; \
        rm -f /tmp/t.tgz; \
    }; \
    install_tar "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz" gitleaks gitleaks; \
    install_tar "https://github.com/trufflesecurity/trufflehog/releases/download/v3.83.7/trufflehog_3.83.7_linux_amd64.tar.gz" trufflehog trufflehog; \
    install_tar "https://github.com/go-gost/gost/releases/download/v3.0.0/gost_3.0.0_linux_amd64.tar.gz" gost gost; \
    rm -f /tmp/t.tgz

# rustscan + ligolo proxy 走各自 release（deb / tar）
RUN set -eux; \
    wget -q -O /tmp/rustscan.deb "https://github.com/RustScan/RustScan/releases/download/2.3.0/rustscan_2.3.0_amd64.deb" \
        && dpkg -i /tmp/rustscan.deb || echo "WARN: rustscan install failed"; \
    rm -f /tmp/rustscan.deb; \
    wget -q -O /tmp/ligolo.tgz "https://github.com/nicocha30/ligolo-ng/releases/download/v0.7.5/ligolo-ng_proxy_0.7.5_linux_amd64.tar.gz" \
        && tar -xzf /tmp/ligolo.tgz -C /tmp proxy \
        && mv /tmp/proxy /usr/local/bin/ligolo-proxy && chmod +x /usr/local/bin/ligolo-proxy \
        || echo "WARN: ligolo-proxy install failed"; \
    rm -f /tmp/ligolo.tgz

# rockyou：wordlists 包已装，解压 rockyou.txt.gz
RUN gunzip -f /usr/share/wordlists/rockyou.txt.gz 2>/dev/null || true

# 命令名对齐：
# 1) httpx —— pip 装的 Python httpx 库 CLI 落在 /usr/local/bin/httpx，会盖过 ProjectDiscovery 的
#    探活工具（apt 包名 httpx-toolkit）。提示词/技能里 `httpx -silent -status-code` 这类用法指的是
#    探测器，所以把 /usr/local/bin/httpx 强制指向 httpx-toolkit；Python httpx 库 import 不受影响。
# 2) testssl —— 包可执行名是 testssl，补一个 testssl.sh 软链兼容习惯写法。
RUN set -eux; \
    if [ -x /usr/bin/httpx-toolkit ]; then ln -sf /usr/bin/httpx-toolkit /usr/local/bin/httpx; fi; \
    if [ -x /usr/bin/testssl ]; then ln -sf /usr/bin/testssl /usr/local/bin/testssl.sh; fi

# 如无需自定义安装，建议删除以下两段（可能重新拉入大量工具）
# COPY build/setup/ /tmp/setup/
# RUN chmod +x /tmp/setup/*.sh
# RUN for script in /tmp/setup/*.sh; do \
#         echo "Executing: $script"; \
#         bash "$script" || exit 1; \
#     done

RUN rm -rf /tmp/setup /tmp/*.zip /tmp/*.deb /var/lib/apt/lists/*

RUN touch /root/THIS_IS_DOCKER_CONTAINER_NOT_TARGET_MACHINE.txt

RUN git clone https://github.com/ticarpi/jwt_tool /opt/jwt_tool \
    && cd /opt/jwt_tool \
    && pip install --break-system-packages  -r requirements.txt \
    && python3 jwt_tool.py -h
