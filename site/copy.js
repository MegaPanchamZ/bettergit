const copyButton = document.querySelector("#copy-install");
const installCommand = document.querySelector("#install-command");
const copyStatus = document.querySelector("#copy-status");

if (navigator.clipboard) {
  let resetLabel;
  copyButton.hidden = false;

  copyButton.addEventListener("click", async () => {
    clearTimeout(resetLabel);
    try {
      await navigator.clipboard.writeText(installCommand.textContent);
      copyButton.textContent = "Copied";
      copyStatus.textContent = "Commands copied.";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(installCommand);
      selection.removeAllRanges();
      selection.addRange(range);
      copyButton.textContent = "Selected";
      copyStatus.textContent = "Install commands selected. Use your keyboard or menu to copy them.";
    }
    resetLabel = setTimeout(() => {
      copyButton.textContent = "Copy";
      copyStatus.textContent = "";
    }, 2200);
  });
}
