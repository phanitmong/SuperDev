// The only file to edit when a release is published.
//
// `releases` is the address the installers are downloaded from, without a file
// name at the end. With GitHub Releases it looks like this (the workflow in
// .github/workflows/release.yml uploads the files there under these names):
//
//   https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY/releases/latest/download
//
// Leave it empty until the first release exists: the download buttons then say
// so instead of pointing at a file that is not there.
window.SUPERDEVOPS = {
  // Shown on the Privacy and Terms pages. Fill these in before the site goes public:
  // the person or company that publishes the app, an address people can write to,
  // and the country (or state) whose law the terms follow.
  publisher: 'Apsara Panel',
  contactEmail: '',
  governingLaw: '',
  version: '1.0.0',
  releases: 'https://github.com/phanitmong/SuperDev/releases/latest/download',
  // Installers that are not built yet. A file named here shows "Coming soon"
  // instead of a link. Remove 'windows' once ApsaraPanel-win-x64.exe is uploaded
  // (npm run dist:win on a Windows computer makes it in release/).
  soon: ['windows'],
  files: {
    macArm: 'ApsaraPanel-mac-arm64.dmg',
    macIntel: 'ApsaraPanel-mac-x64.dmg',
    windows: 'ApsaraPanel-win-x64.exe',
    linux: 'ApsaraPanel-linux-x86_64.AppImage'
  }
}
