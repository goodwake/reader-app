@echo off
echo.
echo  Pushing changes to GitHub...
echo.

git config user.email "abdulazizosamaalazwari@gmail.com"
git config user.name "goodwake"

:: Clear any stale git lock files
if exist ".git\index.lock" del /f ".git\index.lock"
if exist ".git\HEAD.lock" del /f ".git\HEAD.lock"
if exist ".git\objects\maintenance.lock" del /f ".git\objects\maintenance.lock"

git add .
git commit -m "update from Claude session %date% %time%"
git push

echo.
echo  Done! Changes are live on GitHub.
echo.
pause
