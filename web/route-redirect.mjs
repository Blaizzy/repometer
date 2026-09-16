const destination=new URL('../compare.html',location.href);
destination.search=location.search;
destination.hash=location.hash;
location.replace(destination.href);
