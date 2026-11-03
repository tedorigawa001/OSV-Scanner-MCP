FROM python:3.14-bookworm@sha256:a8cf203c684b61fd2676ec5a17159cf68ed38ad471481e1f4ebc4679825250bd
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-arm qemu-efi-aarch64 qemu-utils cloud-image-utils openssh-client \
    && rm -rf /var/lib/apt/lists/*
