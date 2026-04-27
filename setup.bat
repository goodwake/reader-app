@echo off
echo.
echo  Setting up Git for reader-app...
echo.

git init
git config user.email "abdulazizosamaalazwari@gmail.com"
git config user.name "goodwake"
git remote remove origin 2>nul
git remote add origin https://github.com/goodwake/reader-app.git
git branch -M main
git add .
git commit -m "initial setup" 2>nul
git push --force --set-upstream origin main

echo.
echo  Setup complete! You can now use push.bat to push changes.
echo.
pause
