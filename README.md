<p align="center">
  <b style="font-size: 32px;">Tokens² Curated Registry Twitter Bot</b>
</p>

<p align="center">
  <a href="https://standardjs.com"><img src="https://img.shields.io/badge/code_style-standard-brightgreen.svg" alt="JavaScript Style Guide"></a>
  <a href="https://conventionalcommits.org"><img src="https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg" alt="Conventional Commits"></a>
  <a href="http://commitizen.github.io/cz-cli/"><img src="https://img.shields.io/badge/commitizen-friendly-brightgreen.svg" alt="Commitizen Friendly"></a>
  <a href="https://github.com/prettier/prettier"><img src="https://img.shields.io/badge/styled_with-prettier-ff69b4.svg" alt="Styled with Prettier"></a>
</p>

Watches the T2CR and Badge contracts and tweets about relevant events.

# Getting Started

1- Run `yarn`.
2- Duplicate `.env.example` and rename it to `.env`.
3- Review and fill the environment variables.
4- Run `yarn start`.

# Usage with PM2

With `.env` correctly filled, run:

> pm2 start --name t2cr-twitter-bot npm -- run start
