# Instalação e Execução no Linux

O Compazio Community oferece suporte oficial a ambientes Linux x86_64 através de múltiplos formatos
de distribuição.

---

## 1. Formatos Disponíveis

| Formato         | Distribuições Alvo                                                                | Método de Instalação                  |
| :-------------- | :-------------------------------------------------------------------------------- | :------------------------------------ |
| **`.AppImage`** | Todas as distribuições Linux x86_64                                               | Execução direta (portável)            |
| **`.rpm`**      | Fedora, Red Hat Enterprise Linux (RHEL), CentOS, openSUSE, Rocky Linux, AlmaLinux | `dnf` / `rpm` / `zypper`              |
| **Arch Linux**  | Arch Linux, Manjaro, EndeavourOS, Garuda                                          | pacote `.pkg.tar.zst` via `pacman -U` |
| **`.deb`**      | Debian, Ubuntu, Linux Mint, Pop!_OS                                               | `apt` / `dpkg`                        |

---

## 2. Instruções de Instalação

### A. AppImage (Portátil)

O formato AppImage é auto-contido e não requer instalação no sistema.

1. Baixe o arquivo `Compazio-<versão>-x64.AppImage` na página de Releases do GitHub.
2. Dê permissão de execução e inicie:

```bash
chmod +x Compazio-*.AppImage
./Compazio-*.AppImage
```

> **Nota para Ubuntu 24.04+:** Se o AppImage não iniciar por falta de FUSE, instale a biblioteca de
> compatibilidade:
>
> ```bash
> sudo apt install libfuse2t64  # ou libfuse2 no Ubuntu 22.04
> ```

---

### B. Fedora / RHEL / openSUSE (.rpm)

1. Baixe o pacote `compazio-<versão>.x86_64.rpm`.
2. Instale com o gerenciador de pacotes da sua distribuição:

```bash
# Fedora / RHEL / Alma / Rocky:
sudo dnf install ./compazio-*.x86_64.rpm

# openSUSE:
sudo zypper install ./compazio-*.x86_64.rpm
```

---

### C. Arch Linux

Baixe o pacote nativo `.pkg.tar.zst` da release e instale com o `pacman`:

```bash
sudo pacman -U compazio-*-x86_64.pkg.tar.zst
```

> Os arquivos `PKGBUILD` e `.SRCINFO` são gerados junto da release para facilitar uma futura
> publicação no AUR. Não use `yay -S compazio-bin` ou `paru -S compazio-bin` até o pacote estar
> efetivamente publicado no AUR.

---

### D. Debian / Ubuntu (.deb)

1. Baixe o arquivo `compazio_<versão>_amd64.deb`.
2. Instale com `apt`:

```bash
sudo apt install ./compazio_*_amd64.deb
```

---

## 3. Construção Local a Partir do Código Fonte (Linux)

Para empacotar localmente a aplicação no Linux:

### Pré-requisitos do Sistema

```bash
# Ubuntu/Debian:
sudo apt-get install -y build-essential python3 rpm fakeroot libfuse2

# Fedora:
sudo dnf install -y gcc gcc-c++ make python3 rpm-build fakeroot

# Arch Linux:
sudo pacman -S --needed base-devel python rpm-tools fakeroot
```

### Comandos de Build

```bash
# Instalar dependências e compilar monorepo
pnpm install
pnpm build

# Empacotar todos os alvos Linux (.AppImage, .rpm, .pkg.tar.zst, .deb)
pnpm package:linux

# Ou empacotar alvos individuais:
pnpm package:linux:appimage
pnpm package:linux:rpm
pnpm package:linux:pacman
pnpm package:linux:deb
```

Os pacotes gerados ficam localizados em `apps/desktop/release/`.
