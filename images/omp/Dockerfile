FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:3612b800eaae8513e7dca54f21d2e4eda48eda57426f3746a78677f342ac7ee9

ARG OMP_VERSION=18.22.2
ARG OMP_SHA256=80a692c5adb9c71124bb11e77bd7edb3cf8fbbab6980db3206dcb6a4cb2905b5
ARG ACA_VERSION=aca-cli-v1.0.0-preview.5
ARG ACA_SHA256=9c2619f5dc3cb33b99a81e60284614d2ec1016eafb132a803f5678860407355a
ARG DUMBPIPE_VERSION=0.40.1
ARG DUMBPIPE_SHA256=66aee1e249890ee63678dfc8f18ce3671e691673c83bbd72bf9a54c4d32da85c

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        dtach \
        git \
        jq \
        openssh-client \
        openssh-server \
        python3 \
        sqlite3 \
        tmux \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 \
        "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" \
        --output /usr/local/bin/omp \
    && echo "${OMP_SHA256}  /usr/local/bin/omp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/omp \
    && omp --version \
    && curl --fail --location --retry 3 \
        "https://github.com/microsoft/azure-container-apps/releases/download/${ACA_VERSION}/${ACA_VERSION}-linux-x64.tar.gz" \
        --output /tmp/aca.tar.gz \
    && echo "${ACA_SHA256}  /tmp/aca.tar.gz" | sha256sum --check --strict \
    && tar -xzf /tmp/aca.tar.gz -C /usr/local/bin aca \
    && rm /tmp/aca.tar.gz \
    && chmod 0755 /usr/local/bin/aca \
    && aca --version \
    && curl --fail --location --retry 3 \
        "https://github.com/n0-computer/dumbpipe/releases/download/v${DUMBPIPE_VERSION}/dumbpipe-v${DUMBPIPE_VERSION}-linux-x86_64.tar.gz" \
        --output /tmp/dumbpipe.tar.gz \
    && echo "${DUMBPIPE_SHA256}  /tmp/dumbpipe.tar.gz" | sha256sum --check --strict \
    && tar -xzf /tmp/dumbpipe.tar.gz -C /usr/local/bin ./dumbpipe \
    && rm /tmp/dumbpipe.tar.gz \
    && chmod 0755 /usr/local/bin/dumbpipe \
    && dumbpipe --version

COPY entrypoint.sh /usr/local/bin/sand-entrypoint
COPY session.sh /usr/local/bin/sand-omp-session
COPY child-session.sh /usr/local/bin/sand-child-session
COPY ssh-service.sh /usr/local/bin/sand-ssh-service
COPY sand-omp.sh /usr/local/bin/sand-omp
COPY sshd_config /etc/ssh/sshd_config_sand
COPY dispatcher.py /opt/sand/dispatcher.py
COPY sand-extension.ts /opt/sand/sand-extension.ts
RUN chmod 0755 \
    /usr/local/bin/sand-entrypoint \
    /usr/local/bin/sand-omp-session \
    /usr/local/bin/sand-child-session \
    /usr/local/bin/sand-ssh-service \
    /usr/local/bin/sand-omp \
    /opt/sand/dispatcher.py \
 && grep -Fqx 'export TERM="${TERM:-xterm-256color}"' /usr/local/bin/sand-omp-session \
    && grep -Fqx 'PasswordAuthentication no' /etc/ssh/sshd_config_sand \
    && grep -Fqx '    api: openai-completions' /usr/local/bin/sand-child-session \
    && grep -Fq 'await_gateway_client(gateway_token)' /opt/sand/dispatcher.py

ENV HOME=/state/home
ENV PATH=/usr/local/bin:/usr/bin:/bin

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/sand-entrypoint"]
