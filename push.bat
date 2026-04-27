@echo off
echo.
echo  Pushing changes to GitHub...
echo.

git config user.email "abdulazizosamaalazwari@gmail.com"
git config user.name "goodwake"
git add .
git commit -m "update from Claude session %date% %time%"
git push

echo.
echo  Done! Changes are live on GitHub.
echo.
pause
