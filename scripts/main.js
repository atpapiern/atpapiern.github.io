const myImage = document.querySelector("img");

myImage.addEventListener("click", () => {
  const mySrc = myImage.getAttribute("src");
  if (mySrc === "images/ChanticleerBus.jpg") {
    myImage.setAttribute("src", "images/CCU_Blanton_Park.jpg");
  } else {
    myImage.setAttribute("src", "images/ChanticleerBus.jpg");
  }
});

let myButton = document.querySelector("button");
let myHeading = document.querySelector("h1");

function setUserName() {
    const myName = prompt("Please enter your name.");
    if (!myName) {
      setUserName();
    } else {
      localStorage.setItem("name", myName);
      myHeading.textContent = `Coastal is cool, ${myName}`;
    }
  }

if (!localStorage.getItem("name")) {
    setUserName();
  } else {
    const storedName = localStorage.getItem("name");
    myHeading.textContent = `Coastal is cool, ${storedName}`;
  }

myButton.addEventListener("click", () => {
    setUserName();
  });